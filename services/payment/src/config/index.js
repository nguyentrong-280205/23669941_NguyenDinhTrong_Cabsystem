'use strict';
const { loadOwnerConfig } = require('../../../../shared/lib/config');
module.exports = {
  owner: 'payment',
  defaultPort: 3006,
  load() {
    return loadOwnerConfig({
      owner: 'payment',
      defaultPort: 3006,
      required: [
        'KAFKA_BOOTSTRAP_SERVERS',
        'DB_HOST',
        'DB_NAME',
        'DB_USER',
        'DB_PASSWORD',
        'PAYMENT_PROVIDER_URL',
        'PAYMENT_PROVIDER_SECRET',
      ],
    });
  },
};
