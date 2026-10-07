'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { contract } = require('./contracts');
const security = require('./security');
const { context, demand, id, roles } = require('./core');
function createApp(service, components, store) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const supplied = req.headers['x-correlation-id'];
    req.correlationId =
      typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : id();
    res.set('X-Correlation-Id', req.correlationId);
    context.run({ service, correlationId: req.correlationId }, next);
  });
  app.use(
    express.json({
      limit: '64kb',
      verify(req, _res, buffer) {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.get('/api/v1/health-checks', (_req, res) => res.json({ status: 'healthy', service }));
  app.get('/api/v1/readiness-checks', async (_req, res) => {
    try {
      await store.ping();
      if (app.locals.events) await app.locals.events.ping();
      res.json({ status: 'ready' });
    } catch (_) {
      res.status(503).json({ status: 'not_ready' });
    }
  });
  for (const filename of ['openapi', 'internal']) {
    if (
      !fs.existsSync(path.resolve(__dirname, `../../docs/api_document/${service}/${filename}.json`))
    )
      continue;
    for (const operation of contract(service, filename)) {
      const key = `${operation.method.toUpperCase()} ${operation.route}`;
      const route = components.routes.find(
        (r) => r.contract === filename && `${r.method.toUpperCase()} ${r.path}` === key,
      );
      demand(
        route && components.controllers[route.action],
        500,
        'MISSING_HANDLER',
        `${service}: missing ${key}`,
      );
      app[operation.method](operation.route, async (req, res, next) => {
        try {
          if (filename === 'internal') security.authenticateService(req, route.callers || []);
          else if (
            (operation.operation.security || [{ bearerAuth: [] }]).some((s) =>
              Object.hasOwn(s, 'bearerAuth'),
            )
          ) {
            security.authenticate(req);
            if (operation.operation['x-roles']) roles(req.user, ...operation.operation['x-roles']);
            context.getStore().user = req.user;
          }
          if (operation.method !== 'get' && req.body !== undefined)
            demand(req.is('application/json'), 415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON body required');
          operation.validate(req);
          await components.controllers[route.action](req, res, next, operation);
        } catch (error) {
          next(error);
        }
      });
    }
  }
  app.use((_req, res) =>
    res
      .status(404)
      .json({
        code: 'NOT_FOUND',
        message: 'Route not found',
        correlationId: context.getStore()?.correlationId,
      }),
  );
  app.use((error, req, res, _next) => {
    const status =
      error.status ||
      (error.type === 'entity.parse.failed'
        ? 400
        : error.type === 'entity.too.large'
          ? 413
          : ['23505', 11000].includes(error.code)
            ? 409
            : 500);
    console.error(
      JSON.stringify({
        service,
        code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
        correlationId: req.correlationId,
      }),
    );
    res
      .status(status)
      .json({
        code:
          status >= 500
            ? 'SERVICE_ERROR'
            : error.code || (status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: status >= 500 ? 'Service could not complete the request' : error.message,
        correlationId: req.correlationId,
      });
  });
  return app;
}
async function boot(service) {
  const config = require(path.resolve(__dirname, `../../services/${service}/src/config`)).load();
  const repository = require(
    path.resolve(__dirname, `../../services/${service}/src/repositories/${service}.repository`),
  );
  const store = repository.createStore();
  await store.init();
  const app = require(path.resolve(__dirname, `../../services/${service}/src/app`))(store);
  const components = app.locals.components;
  const { startEvents } = require('./events');
  app.locals.events = await startEvents(store, service, components.subscriptions);
  let working = false;
  const timer = setInterval(async () => {
    if (working) return;
    working = true;
    try {
      await context.run({ service }, () => components.tick?.());
    } catch (_) {
      console.error(JSON.stringify({ service, code: 'WORKFLOW_RETRY' }));
    } finally {
      working = false;
    }
  }, 1000);
  timer.unref();
  const server = app.listen(config.port, '0.0.0.0');
  async function close() {
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    while (working) await new Promise((resolve) => setTimeout(resolve, 20));
    await app.locals.events.close();
    await store.close();
  }
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () =>
      close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1)),
    );
  return { app, store, server, close };
}
module.exports = { boot, createApp };
