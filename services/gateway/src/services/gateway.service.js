'use strict';
const C = require('../../../../shared/lib/core');
const SERVICES = ['identity', 'customer', 'driver', 'booking', 'trip', 'payment', 'notification'];
module.exports = (repository, fetcher = fetch) => ({
  async consumeQuota(key, limit) {
    const { count, ttl } = await repository.incrementWindow(key);
    if (count > limit) {
      const error = new Error('Request limit exceeded; retry after the current window');
      Object.assign(error, {
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
      });
      throw error;
    }
  },
  async readiness() {
    const services = await Promise.all(
      SERVICES.map(async (name) => {
        try {
          const response = await fetcher(
            `${process.env[`${name.toUpperCase()}_SERVICE_URL`]}/api/v1/readiness-checks`,
            { signal: AbortSignal.timeout(2500) },
          );
          return { name: `${name}-service`, status: response.ok ? 'healthy' : 'degraded' };
        } catch (_) {
          return { name: `${name}-service`, status: 'unavailable' };
        }
      }),
    );
    let ready = services.every((row) => row.status === 'healthy');
    try {
      await repository.ping();
    } catch (_) {
      ready = false;
      services.push({ name: 'redis', status: 'unavailable' });
    }
    return { ready, services };
  },
  async proxy(input) {
    C.demand(SERVICES.includes(input.owner), 500, 'CONFIGURATION_ERROR', 'Invalid Gateway owner');
    const headers = { 'content-type': 'application/json', 'x-correlation-id': input.correlationId };
    for (const name of ['authorization', 'idempotency-key', 'x-provider-signature'])
      if (input.headers[name]) headers[name] = input.headers[name];
    let response;
    try {
      response = await fetcher(
        `${process.env[`${input.owner.toUpperCase()}_SERVICE_URL`]}${input.path}`,
        {
          method: input.method,
          headers,
          body: input.method === 'GET' ? undefined : input.rawBody,
          signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS || 5000)),
        },
      );
    } catch (error) {
      C.fail(
        error.name === 'TimeoutError' ? 504 : 503,
        'SERVICE_UNAVAILABLE',
        'Upstream service is unavailable',
      );
    }
    return {
      status: response.status,
      body: response.status === 204 ? undefined : await response.json(),
      retryAfter: response.headers.get('retry-after'),
    };
  },
  async sandboxMessages() {
    const response = await fetcher(`${process.env.SANDBOX_URL}/api/v1/messages`, {
      headers: { authorization: `Bearer ${C.secret('NOTIFICATION_PROVIDER_SECRET')}` },
      signal: AbortSignal.timeout(3000),
    });
    C.demand(response.ok, 503, 'SANDBOX_UNAVAILABLE', 'Sandbox unavailable');
    return response.json();
  },
});
