'use strict';
const jwt = require('jsonwebtoken');
const { demand, secret, equal } = require('./core');
const issuer = 'cab-identity';
function accessToken(user) {
  return jwt.sign(
    {
      userId: user.userId,
      role: user.role,
      customerId: user.customerId,
      driverId: user.driverId,
      purpose: 'ACCESS',
    },
    secret('JWT_SECRET'),
    { algorithm: 'HS256', issuer, audience: 'cab-api' },
  );
}
function registrationToken(challenge) {
  return jwt.sign(
    { challengeId: challenge.challengeId, purpose: 'DRIVER_REGISTRATION' },
    secret('REGISTRATION_SECRET'),
    { algorithm: 'HS256', issuer, audience: 'cab-driver-registration' },
  );
}
function verifyRegistration(token) {
  try {
    const p = jwt.verify(token, secret('REGISTRATION_SECRET'), {
      algorithms: ['HS256'],
      ignoreExpiration: true,
      ignoreNotBefore: true,
      issuer,
      audience: 'cab-driver-registration',
    });
    demand(p.purpose === 'DRIVER_REGISTRATION', 400, 'INVALID_TOKEN', 'Invalid registration token');
    return p;
  } catch (_) {
    demand(false, 400, 'INVALID_TOKEN', 'Invalid registration token');
  }
}
function authenticate(req) {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
  demand(token, 401, 'UNAUTHORIZED', 'Access token required');
  try {
    const user = jwt.verify(token, secret('JWT_SECRET'), {
      algorithms: ['HS256'],
      ignoreExpiration: true,
      ignoreNotBefore: true,
      issuer,
      audience: 'cab-api',
    });
    demand(
      user.purpose === 'ACCESS' &&
        typeof user.userId === 'string' &&
        ['CUSTOMER', 'DRIVER', 'ADMIN', 'OPERATOR'].includes(user.role),
      401,
      'UNAUTHORIZED',
      'Invalid access token',
    );
    user.accessToken = token;
    req.user = user;
    return user;
  } catch (_) {
    demand(false, 401, 'UNAUTHORIZED', 'Invalid access token');
  }
}
function authenticateService(req, allowed) {
  const caller = req.headers['x-service-name'],
    tokens = JSON.parse(process.env.SERVICE_TOKENS || '{}');
  demand(
    typeof caller === 'string' &&
      allowed.includes(caller) &&
      tokens[caller] &&
      equal(req.headers['x-service-token'], tokens[caller]),
    401,
    'UNAUTHORIZED',
    'Invalid internal service authentication',
  );
  req.caller = caller;
  if (req.headers['x-actor-token'])
    req.actor = authenticate({
      headers: { authorization: `Bearer ${req.headers['x-actor-token']}` },
    });
  if (req.headers['x-user-context'])
    demand(req.actor, 401, 'UNAUTHORIZED', 'An independently verifiable actor token is required');
}
module.exports = {
  accessToken,
  registrationToken,
  verifyRegistration,
  authenticate,
  authenticateService,
};
