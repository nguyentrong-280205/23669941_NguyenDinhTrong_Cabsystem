'use strict';
module.exports = (redis, fetcher) => {
  const repository = require('./repositories/gateway.repository')(redis);
  const service = require('./services/gateway.service')(repository, fetcher);
  return { service, controller: require('./controllers/gateway.controller')(service) };
};
