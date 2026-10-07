'use strict';
const express = require('express');
const C = require('../../../shared/lib/core');
module.exports = (redis, fetcher) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    const supplied = req.headers['x-correlation-id'];
    req.correlationId =
      typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : C.id();
    res.set('X-Correlation-Id', req.correlationId);
    C.context.run({ service: 'gateway', correlationId: req.correlationId }, next);
  });
  app.use((req, res, next) => {
    const origin = req.headers.origin,
      allowed = (process.env.CORS_ORIGINS || '').split(',');
    if (origin && allowed.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,Idempotency-Key,X-Correlation-Id',
      );
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(
    express.json({
      limit: '64kb',
      verify(req, _res, bytes) {
        req.rawBody = Buffer.from(bytes);
      },
    }),
  );
  const components = require('./index')(redis, fetcher);
  app.locals.components = components;
  require('./routes/gateway.routes')(app, components.controller);
  app.use((_req, res) =>
    res
      .status(404)
      .json({
        code: 'NOT_FOUND',
        message: 'Route not found',
        correlationId: C.context.getStore()?.correlationId,
      }),
  );
  app.use((error, req, res, _next) => {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    const status =
      error.status ||
      (error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 503);
    res
      .status(status)
      .json({
        code: error.code || 'SERVICE_ERROR',
        message: status >= 500 ? 'Service unavailable' : error.message,
        correlationId: req.correlationId,
      });
  });
  return app;
};
