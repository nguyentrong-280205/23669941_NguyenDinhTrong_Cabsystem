'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/notification.repository')(store);
  const service = require('./services/notification.service')(repository);
  return {
    routes: require('./routes/notification.routes'),
    controllers: require('./controllers/notification.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
