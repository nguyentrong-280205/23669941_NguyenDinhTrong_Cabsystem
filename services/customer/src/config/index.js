'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'customer',
  defaultPort: 3002,
  load() {
    return loadOwnerConfig({
      owner: 'customer',
      defaultPort: 3002,
      required: ['KAFKA_BOOTSTRAP_SERVERS', 'MONGO_URI', 'MONGO_DB'],
    });
  },
};
