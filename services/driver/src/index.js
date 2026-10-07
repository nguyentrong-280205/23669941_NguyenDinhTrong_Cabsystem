'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/driver.repository')(store);
  const service = require('./services/driver.service')(repository);
  return {
    routes: require('./routes/driver.routes'),
    controllers: require('./controllers/driver.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
