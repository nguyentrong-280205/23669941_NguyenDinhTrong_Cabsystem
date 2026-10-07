'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function fail(status, code, message) {
  const e = new Error(message);
  Object.assign(e, { status, code });
  throw e;
}
function demand(
  ok,
  status = 409,
  code = 'INVALID_STATE',
  message = 'Operation is not allowed in the current state',
) {
  if (!ok) fail(status, code, message);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function secret(name) {
  const value = process.env[name];
  demand(
    value && value.length >= 32,
    500,
    'CONFIGURATION_ERROR',
    `${name} must be configured with at least 32 characters`,
  );
  return value;
}
function hmac(value, name = 'OTP_SECRET') {
  return crypto.createHmac('sha256', secret(name)).update(value).digest('hex');
}
function equal(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function encrypt(value) {
  const version = process.env.ENCRYPTION_KEY_VERSION || 'v1';
  const key = Buffer.from(secret('ENCRYPTION_KEY'), 'hex');
  demand(key.length === 32, 500, 'CONFIGURATION_ERROR', 'ENCRYPTION_KEY must be 64 hex characters');
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return `${version}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}
function decrypt(value) {
  const [version, iv, tag, ciphertext] = value.split(':');
  const raw =
    version === (process.env.ENCRYPTION_KEY_VERSION || 'v1')
      ? secret('ENCRYPTION_KEY')
      : process.env[`ENCRYPTION_KEY_${version}`];
  demand(raw, 500, 'CONFIGURATION_ERROR', 'Encryption key version unavailable');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(raw, 'hex'),
    Buffer.from(iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString(),
  );
}
function page(query = {}) {
  const parse = (x, fallback, max) => {
    if (x === undefined) return fallback;
    demand(
      /^\d+$/.test(String(x)) && Number(x) >= 1 && Number(x) <= max,
      400,
      'VALIDATION_ERROR',
      'Invalid pagination',
    );
    return Number(x);
  };
  return {
    page: parse(query.page, 1, Number.MAX_SAFE_INTEGER),
    limit: parse(query.limit, 10, 100),
  };
}
function paginate(items, query) {
  const p = page(query);
  return {
    ...p,
    total: items.length,
    items: items.slice((p.page - 1) * p.limit, p.page * p.limit),
  };
}
function roles(user, ...allowed) {
  demand(user && allowed.includes(user.role), 403, 'FORBIDDEN', 'Insufficient permissions');
}
function owner(user, kind, identifier, staff = true) {
  demand(
    user &&
      ((staff && ['ADMIN', 'OPERATOR'].includes(user.role)) || user[`${kind}Id`] === identifier),
    403,
    'FORBIDDEN',
    'Resource belongs to another user',
  );
}
async function audit(tx, action, targetId, actor) {
  await tx.create('audit', id(), {
    action,
    targetId,
    actorUserId: actor || context.getStore()?.user?.userId || 'system',
    correlationId: context.getStore()?.correlationId || id(),
    createdAt: now(),
  });
}
async function ipc(service, route, { method = 'GET', body, user } = {}) {
  const url = process.env[`${service.toUpperCase()}_SERVICE_URL`];
  demand(url, 500, 'CONFIGURATION_ERROR', 'Missing internal service URL');
  const caller = context.getStore()?.service || process.env.SERVICE_NAME;
  const token = secret('SERVICE_TOKEN');
  const headers = {
    'content-type': 'application/json',
    'x-service-name': caller,
    'x-service-token': token,
    'x-correlation-id': context.getStore()?.correlationId || id(),
  };
  if (user) {
    demand(user.accessToken, 401, 'UNAUTHORIZED', 'Actor token is required');
    headers['x-actor-token'] = user.accessToken;
  }
  let response;
  try {
    response = await fetch(`${url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS || 4000)),
    });
  } catch (error) {
    fail(
      error.name === 'TimeoutError' ? 504 : 503,
      'DEPENDENCY_UNAVAILABLE',
      'Internal dependency unavailable',
    );
  }
  const result = await response.json();
  if (!response.ok)
    fail(
      response.status,
      result.code || 'DEPENDENCY_ERROR',
      result.message || 'Internal request failed',
    );
  return result;
}
module.exports = {
  id,
  now,
  fail,
  demand,
  hash,
  secret,
  hmac,
  equal,
  encrypt,
  decrypt,
  page,
  paginate,
  roles,
  owner,
  audit,
  ipc,
  context,
};
