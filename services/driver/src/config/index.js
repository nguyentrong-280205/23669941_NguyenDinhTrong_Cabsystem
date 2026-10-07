'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'driver',
  defaultPort: 3003,
  load() {
    return loadOwnerConfig({
      owner: 'driver',
      defaultPort: 3003,
      required: ['KAFKA_BOOTSTRAP_SERVERS', 'MONGO_URI', 'MONGO_DB'],
    });
  },
};
