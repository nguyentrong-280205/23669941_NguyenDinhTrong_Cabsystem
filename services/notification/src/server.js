'use strict';
require('../../../shared/lib/runtime')
  .boot('notification')
  .catch(() => {
    console.error('notification: startup failed; check dependencies and configuration');
    process.exit(1);
  });
