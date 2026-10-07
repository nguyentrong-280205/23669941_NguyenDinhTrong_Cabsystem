'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/customer.repository')(store);
  const service = require('./services/customer.service')(repository);
  return {
    routes: require('./routes/customer.routes'),
    controllers: require('./controllers/customer.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
