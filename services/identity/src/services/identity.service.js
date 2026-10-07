'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const C = require('../../../../shared/lib/core');
const S = require('../../../../shared/lib/security');
const { emit } = require('../../../../shared/lib/events');
module.exports = (repository) => {
  async function profile(userId, tx = repository) {
    const user = await tx.get('users', userId);
    C.demand(user, 404, 'NOT_FOUND', 'User not found');
    const { passwordHash, ...safe } = user;
    if (!safe.phone) delete safe.phone;
    if (!safe.email) delete safe.email;
    return safe;
  }
  async function complete(workflow) {
    const body = C.decrypt(workflow.encryptedPayload);
    const result = await C.ipc(
      workflow.profileType === 'CUSTOMER' ? 'customer' : 'driver',
      `/api/v1/internal-${workflow.profileType.toLowerCase()}-registrations`,
      { method: 'POST', body },
    );
    return repository.tx(async (tx) => {
      const current = await tx.get('registrations', workflow.registrationId);
      if (current.status === 'COMPLETED') return current.result;
      const user = await tx.get('users', current.userId);
      const identifier = workflow.profileType === 'CUSTOMER' ? result.customerId : result.driverId;
      C.demand(identifier, 503, 'DEPENDENCY_ERROR', 'Profile creation has not completed');
      const response =
        workflow.profileType === 'CUSTOMER'
          ? { userId: user.userId, customerId: identifier }
          : { driverId: identifier, approvalStatus: 'PENDING', availabilityStatus: 'OFFLINE' };
      await tx.put('users', user.userId, {
        ...user,
        [workflow.profileType === 'CUSTOMER' ? 'customerId' : 'driverId']: identifier,
        registrationStatus: 'COMPLETED',
        updatedAt: C.now(),
      });
      await tx.put('registrations', current.registrationId, {
        ...current,
        status: 'COMPLETED',
        result: response,
        encryptedPayload: null,
      });
      await C.audit(tx, 'registration.completed', user.userId, user.userId);
      return response;
    });
  }
  async function register(payload, kind) {
    const fingerprint = C.hmac(JSON.stringify(payload));
    const email = payload.email?.trim().toLowerCase(),
      phone = payload.phone?.trim();
    let challenge;
    if (kind === 'DRIVER') {
      const token = S.verifyRegistration(payload.registrationToken);
      challenge = await repository.get('challenges', token.challengeId);
      C.demand(challenge?.verifiedAt, 400, 'INVALID_TOKEN', 'OTP verification required');
    }
    const actualPhone = challenge?.phone || phone;
    const passwordHash = await bcrypt.hash(payload.password, 12);
    const workflow = await repository.tx(async (tx) => {
      const existing = (await tx.list('users')).find(
        (u) => (actualPhone && u.phone === actualPhone) || (email && u.email === email),
      );
      if (existing) {
        const registration = await tx.get('registrations', existing.registrationId);
        C.demand(
          registration &&
            registration.requestHash === fingerprint &&
            registration.profileType === kind,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Registration already exists with different data',
        );
        return registration;
      }
      if (challenge) {
        const fresh = await tx.get('challenges', challenge.challengeId);
        C.demand(
          !fresh.registrationId,
          409,
          'TOKEN_ALREADY_USED',
          'Registration token already used',
        );
      }
      const userId = C.id(),
        registrationId = C.id();
      const user = {
        userId,
        registrationId,
        fullName: payload.fullName.trim(),
        phone: actualPhone || null,
        email: email || null,
        passwordHash,
        role: kind,
        status: 'ACTIVE',
        registrationStatus: 'PENDING',
        createdAt: C.now(),
        updatedAt: C.now(),
      };
      await tx.create('users', userId, user);
      const request =
        kind === 'CUSTOMER'
          ? { registrationId, userId }
          : {
              registrationId,
              userId,
              profile: { licenseNumber: payload.licenseNumber },
              vehicle: payload.vehicle,
            };
      const row = {
        registrationId,
        userId,
        profileType: kind,
        requestHash: fingerprint,
        encryptedPayload: C.encrypt(request),
        status: 'PENDING',
        createdAt: C.now(),
      };
      await tx.create('registrations', registrationId, row);
      if (challenge) {
        const fresh = await tx.get('challenges', challenge.challengeId);
        await tx.put('challenges', fresh.challengeId, { ...fresh, registrationId });
      }
      await C.audit(tx, 'registration.started', userId, userId);
      return row;
    });
    if (workflow.status === 'COMPLETED') return workflow.result;
    return complete(workflow);
  }
  const actions = {
    registerCustomer: (input) => register(input.body, 'CUSTOMER'),
    registerDriver: (input) => register(input.body, 'DRIVER'),
    login: async (input, allowedRoles) => {
      const users = await repository.list('users');
      const email = input.body.email?.trim().toLowerCase();
      const user = users.find((u) => (email ? u.email === email : u.phone === input.body.phone));
      C.demand(
        user && allowedRoles.includes(user.role) && (await bcrypt.compare(input.body.password, user.passwordHash)),
        401,
        'INVALID_CREDENTIALS',
        'Invalid credentials',
      );
      C.demand(
        user.status === 'ACTIVE' && user.registrationStatus === 'COMPLETED',
        403,
        'ACCOUNT_NOT_ACTIVE',
        'Account registration is incomplete or access is disabled',
      );
      return { accessToken: S.accessToken(user), tokenType: 'Bearer', expiresIn: null };
    },
    requestDriverOtp: async (input) =>
      repository.tx(async (tx) => {
        const previous = await tx.list('challenges', { phone: input.body.phone });
        for (const row of previous.filter((c) => !c.consumedAt))
          await tx.put('challenges', row.challengeId, { ...row, consumedAt: C.now() });
        const challengeId = C.id(),
          otp = crypto.randomInt(0, 1000000).toString().padStart(6, '0'),
          expiresAt = null;
        const row = {
          challengeId,
          phone: input.body.phone,
          purpose: 'DRIVER_REGISTRATION',
          otpDigest: C.hmac(`${challengeId}:${otp}`),
          expiresAt,
          attempts: 0,
          createdAt: C.now(),
        };
        await tx.create('challenges', challengeId, row);
        await emit(tx, 'otp.requested', challengeId, 1, {
          challengeId,
          expiresAt,
          encryptedPayload: C.encrypt({ phone: row.phone, otp }),
          keyVersion: process.env.ENCRYPTION_KEY_VERSION || 'v1',
        });
        return { challengeId, expiresIn: null };
      }),
    verifyDriverOtp: async (input) => {
      const result = await repository.tx(async (tx) => {
        const challenge = await tx.get('challenges', input.body.challengeId);
        C.demand(
          challenge && !challenge.consumedAt && challenge.attempts < 5,
          400,
          'INVALID_OTP',
          'OTP challenge is consumed or locked',
        );
        if (!C.equal(challenge.otpDigest, C.hmac(`${challenge.challengeId}:${input.body.otp}`))) {
          await tx.put('challenges', challenge.challengeId, {
            ...challenge,
            attempts: challenge.attempts + 1,
          });
          return { incorrect: true };
        }
        await tx.put('challenges', challenge.challengeId, {
          ...challenge,
          consumedAt: C.now(),
          verifiedAt: C.now(),
        });
        return { registrationToken: S.registrationToken(challenge) };
      });
      C.demand(!result.incorrect, 400, 'INVALID_OTP', 'Incorrect OTP');
      return result;
    },
    getUserProfile: (input) => profile(input.params.userId),
    updateUser: async (input) =>
      repository.tx(async (tx) => {
        C.demand(
          input.actor?.userId === input.body.actorUserId,
          403,
          'FORBIDDEN',
          'Authenticated actor required',
        );
        const self = input.actor.userId === input.params.userId;
        C.demand(
          (self && input.body.status === undefined) ||
            ['ADMIN', 'OPERATOR'].includes(input.actor.role),
          403,
          'FORBIDDEN',
          'Actor cannot change this account',
        );
        const key = `${input.caller}:${input.body.operationId}`,
          previous = await tx.get('operations', key),
          requestHash = C.hash({ id: input.params.userId, body: input.body });
        if (previous) {
          C.demand(
            previous.requestHash === requestHash,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Operation ID reused',
          );
          return previous.result;
        }
        const user = await tx.get('users', input.params.userId);
        C.demand(user, 404, 'NOT_FOUND', 'User not found');
        const { operationId, actorUserId, ...fields } = input.body;
        if (fields.email) fields.email = fields.email.trim().toLowerCase();
        const updated = { ...user, ...fields, updatedAt: C.now() };
        await tx.put('users', user.userId, updated);
        const result = await profile(user.userId, tx);
        await tx.create('operations', key, { requestHash, result });
        await C.audit(tx, 'user.updated', user.userId, actorUserId);
        return result;
      }),
  };
  return {
    actions,
    async tick() {
      for (const workflow of await repository.list('registrations', { status: 'PENDING' })) {
        try {
          await complete(workflow);
        } catch (_) {
          /* durable pending workflow, retry next tick */
        }
      }
    },
  };
};
