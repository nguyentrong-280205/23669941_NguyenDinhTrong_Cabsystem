'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'identity',
  defaultPort: 3001,
  load() {
    return loadOwnerConfig({
      owner: 'identity',
      defaultPort: 3001,
      required: ['KAFKA_BOOTSTRAP_SERVERS', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
    });
  },
};
