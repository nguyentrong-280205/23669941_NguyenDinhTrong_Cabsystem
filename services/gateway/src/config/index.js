'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'gateway',
  defaultPort: 8080,
  load() {
    return loadOwnerConfig({ owner: 'gateway', defaultPort: 8080, required: ['REDIS_URL'] });
  },
};
