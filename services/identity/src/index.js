'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/identity.repository')(store);
  const service = require('./services/identity.service')(repository);
  return {
    routes: require('./routes/identity.routes'),
    controllers: require('./controllers/identity.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
