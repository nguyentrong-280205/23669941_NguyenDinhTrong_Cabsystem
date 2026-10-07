'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/trip.repository')(store);
  const service = require('./services/trip.service')(repository);
  return {
    routes: require('./routes/trip.routes'),
    controllers: require('./controllers/trip.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
