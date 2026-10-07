'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'trip',
  defaultPort: 3005,
  load() {
    return loadOwnerConfig({
      owner: 'trip',
      defaultPort: 3005,
      required: ['KAFKA_BOOTSTRAP_SERVERS', 'MONGO_URI', 'MONGO_DB'],
    });
  },
};
