'use strict';
async function boot() {
  const config = require('./config').load();
  const redis = await require('./repositories/gateway.repository').connect();
  const app = require('./app')(redis),
    server = app.listen(config.port, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => server.close(() => redis.quit().then(() => process.exit(0))));
  return { app, redis, server };
}
if (require.main === module)
  boot().catch(() => {
    console.error('gateway: startup failed; check dependencies and configuration');
    process.exit(1);
  });
module.exports = { boot };
