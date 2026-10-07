'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'notification',
  defaultPort: 3007,
  load() {
    return loadOwnerConfig({
      owner: 'notification',
      defaultPort: 3007,
      required: [
        'KAFKA_BOOTSTRAP_SERVERS',
        'MONGO_URI',
        'MONGO_DB',
        'NOTIFICATION_PROVIDER_URL',
        'NOTIFICATION_PROVIDER_SECRET',
      ],
    });
  },
};
