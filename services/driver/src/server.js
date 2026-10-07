'use strict';
require('../../../shared/lib/runtime')
  .boot('driver')
  .catch(() => {
    console.error('driver: startup failed; check dependencies and configuration');
    process.exit(1);
  });
