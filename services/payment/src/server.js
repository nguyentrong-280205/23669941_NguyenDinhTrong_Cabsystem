'use strict';
require('../../../shared/lib/runtime')
  .boot('payment')
  .catch(() => {
    console.error('payment: startup failed; check dependencies and configuration');
    process.exit(1);
  });
