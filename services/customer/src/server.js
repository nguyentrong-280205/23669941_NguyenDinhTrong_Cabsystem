'use strict';
require('../../../shared/lib/runtime')
  .boot('customer')
  .catch(() => {
    console.error('customer: startup failed; check dependencies and configuration');
    process.exit(1);
  });
