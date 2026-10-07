'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'booking',
  defaultPort: 3004,
  load() {
    return loadOwnerConfig({
      owner: 'booking',
      defaultPort: 3004,
      required: ['KAFKA_BOOTSTRAP_SERVERS', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
    });
  },
};
