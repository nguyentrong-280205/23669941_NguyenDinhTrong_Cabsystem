'use strict';
module.exports = (store) => {
  const components = require('./index')(store);
  const app = require('../../../shared/lib/runtime').createApp('notification', components, store);
  app.locals.components = components;
  return app;
};
