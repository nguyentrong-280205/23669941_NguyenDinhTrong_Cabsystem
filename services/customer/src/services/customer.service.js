'use strict';
const C = require('../../../../shared/lib/core');
const S = require('../../../../shared/lib/security');
module.exports = (repository) => {
  async function registrationTransaction(work) {
    // Concurrent first registrations can race to insert the counter in MongoDB.
    for (let attempt = 0; ; attempt++) {
      try {
        return await repository.tx(work);
      } catch (error) {
        if (error.code !== 11000 || attempt >= 4) throw error;
      }
    }
  }
  async function nextCustomerId(tx) {
    const key = 'customer-id-sequence';
    const counter = await tx.get('runtime', key);
    let last = counter?.value;
    if (last === undefined) {
      last = 0;
      for (const customer of await tx.list('customers')) {
        if (/^CU\d+$/.test(customer.customerId))
          last = Math.max(last, Number(customer.customerId.slice(2)));
      }
    }
    const value = last + 1;
    C.demand(Number.isSafeInteger(value), 500, 'ID_SEQUENCE_EXHAUSTED', 'Customer ID sequence exhausted');
    await tx.put('runtime', key, { value });
    return `CU${String(value).padStart(2, '0')}`;
  }
  async function get(id, tx = repository) {
    const customer = await tx.get('customers', id);
    C.demand(customer, 404, 'NOT_FOUND', 'Customer not found');
    return customer;
  }
  async function finish(job) {
    if (job.status === 'COMPLETED') return job.result;
    const customer = await get(job.customerId);
    const user = S.authenticate({
      headers: { authorization: `Bearer ${C.decrypt(job.actorToken)}` },
    });
    const { defaultPaymentMethod, operationId, ...fields } = job.body;
    if (Object.keys(fields).length)
      await C.ipc('identity', `/api/v1/internal/users/${customer.userId}`, {
        method: 'PATCH',
        user,
        body: { operationId, actorUserId: user.userId, ...fields },
      });
    return repository.tx(async (tx) => {
      const completed = await tx.get('changes', job.key);
      if (completed?.status === 'COMPLETED') return completed.result;
      const current = await get(customer.customerId, tx);
      if (defaultPaymentMethod)
        await tx.put('customers', current.customerId, {
          ...current,
          defaultPaymentMethod,
          updatedAt: C.now(),
        });
      const result = { customerId: customer.customerId, updated: true };
      await tx.put('changes', job.key, {
        ...job,
        body: null,
        actorToken: null,
        status: 'COMPLETED',
        result,
      });
      await C.audit(tx, 'customer.updated', customer.customerId, job.actorUserId);
      return result;
    });
  }
  async function change(input) {
    const customer = await get(input.params.id);
    C.demand(
      ['ADMIN', 'OPERATOR'].includes(input.user.role) || input.user.userId === customer.userId,
      403,
      'FORBIDDEN',
      'Customer belongs to another user',
    );
    const job = await repository.tx(async (tx) => {
      const key = `${customer.customerId}:${input.body.operationId}`,
        requestHash = C.hash(input.body),
        previous = await tx.get('changes', key);
      if (previous) {
        C.demand(
          previous.requestHash === requestHash && previous.actorUserId === input.user.userId,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Operation ID reused',
        );
        if (previous.status === 'COMPLETED') return previous;
      }
      const row = {
        key,
        customerId: customer.customerId,
        requestHash,
        actorUserId: input.user.userId,
        actorToken: C.encrypt(input.user.accessToken),
        body: input.body,
        status: 'PENDING',
        createdAt: C.now(),
      };
      await tx.put('changes', key, row);
      return row;
    });
    return finish(job);
  }
  return {
    actions: {
      updateCustomer: change,
      updateCustomerStatus: change,
      createCustomerRegistration: (input) =>
        registrationTransaction(async (tx) => {
          const body = input.body,
            requestHash = C.hash(body);
          const existing = (await tx.list('customers', { registrationId: body.registrationId }))[0];
          if (existing) {
            C.demand(
              existing.requestHash === requestHash,
              409,
              'IDEMPOTENCY_CONFLICT',
              'Registration ID reused',
            );
            return existing;
          }
          C.demand(
            !(await tx.list('customers', { userId: body.userId })).length,
            409,
            'DUPLICATE_ENTITY',
            'User already has a Customer profile',
          );
          const customerId = await nextCustomerId(tx),
            customer = {
              customerId,
              userId: body.userId,
              registrationId: body.registrationId,
              requestHash,
              defaultPaymentMethod: 'CASH',
              createdAt: C.now(),
              updatedAt: C.now(),
            };
          await tx.create('customers', customerId, customer);
          await C.audit(tx, 'customer.created', customerId, body.userId);
          return customer;
        }),
      getCustomerRegistration: async (input) => {
        const customer = (
          await repository.list('customers', { registrationId: input.params.registrationId })
        )[0];
        C.demand(customer, 404, 'NOT_FOUND', 'Registration not found');
        return customer;
      },
      getCustomerInternal: (input) => get(input.params.id),
      getCustomerProfile: async (input) => {
        const customer = await get(input.params.id);
        C.demand(
          ['ADMIN', 'OPERATOR'].includes(input.user.role) || input.user.userId === customer.userId,
          403,
          'FORBIDDEN',
          'Customer profile belongs to another user',
        );
        const user = await C.ipc(
          'identity',
          `/api/v1/internal/users/${encodeURIComponent(customer.userId)}/profiles`,
        );
        return {
          customerId: customer.customerId,
          userId: customer.userId,
          fullName: user.fullName,
          ...(user.phone ? { phone: user.phone } : {}),
          ...(user.email ? { email: user.email } : {}),
          defaultPaymentMethod: customer.defaultPaymentMethod,
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
        };
      },
    },
    async tick() {
      for (const row of await repository.list('changes', { status: 'PENDING' })) {
        try {
          await finish(row);
        } catch (_) {}
      }
    },
  };
};
