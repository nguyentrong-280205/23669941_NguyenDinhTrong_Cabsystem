'use strict';
const C = require('../../../../shared/lib/core');
const { authorize } = require('../middleware/auth.middleware');
module.exports = (service) => ({
  handle(operation) {
    return async (req, res, next) => {
      try {
        const requiresUser = (operation.operation.security || [{ bearerAuth: [] }]).some((item) =>
          Object.hasOwn(item, 'bearerAuth'),
        );
        if (requiresUser)
          await authorize(
            req,
            operation.operation['x-roles'] || ['CUSTOMER', 'DRIVER', 'ADMIN', 'OPERATOR'],
          );
        operation.validate(req);
        if (operation.route === '/api/v1/health') return res.json({ status: 'healthy' });
        if (['/api/v1/ready', '/api/v1/health/services'].includes(operation.route)) {
          const { ready, services } = await service.readiness();
          return res
            .status(ready ? 200 : 503)
            .json(
              operation.route === '/api/v1/ready'
                ? { status: ready ? 'ready' : 'not_ready' }
                : { status: ready ? 'healthy' : 'degraded', services },
            );
        }
        C.demand(
          req.method === 'GET' || req.is('application/json'),
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'JSON body required',
        );
        await service.consumeQuota(`ip:${req.socket.remoteAddress}`, 120);
        if (operation.route === '/api/v1/bookings' && req.method === 'POST')
          await service.consumeQuota(`booking-user:${req.user.userId}`, 30);
        const result = await service.proxy({
          owner: operation.operation['x-service-owner'],
          method: req.method.toUpperCase(),
          path: req.originalUrl,
          headers: req.headers,
          rawBody: req.rawBody,
          correlationId: req.correlationId,
        });
        if (result.retryAfter) res.set('Retry-After', result.retryAfter);
        if (result.status >= 200 && result.status < 300)
          operation.response(result.status, result.body);
        if (result.status === 204) return res.status(204).end();
        return res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  },
  async sandboxMessages(req, res, next) {
    try {
      await authorize(req, ['ADMIN']);
      await service.consumeQuota(`sandbox:${req.user.userId}`, 30);
      res.json(await service.sandboxMessages());
    } catch (error) {
      next(error);
    }
  },
});
