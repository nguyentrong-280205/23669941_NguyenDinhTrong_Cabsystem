'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/payment.repository')(store);
  const service = require('./services/payment.service')(repository);
  return {
    routes: require('./routes/payment.routes'),
    controllers: require('./controllers/payment.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
