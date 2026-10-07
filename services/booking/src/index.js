'use strict';
// Composition root: connect persistence -> business service -> HTTP controllers/routes.
module.exports = (store) => {
  const repository = require('./repositories/booking.repository')(store);
  const service = require('./services/booking.service')(repository);
  return {
    routes: require('./routes/booking.routes'),
    controllers: require('./controllers/booking.controller')(service),
    actions: service.actions,
    subscriptions: service.subscriptions || [],
    tick: service.tick,
  };
};
