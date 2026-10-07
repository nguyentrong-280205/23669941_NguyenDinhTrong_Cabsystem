'use strict';
require('../../../shared/lib/runtime')
  .boot('identity')
  .catch(() => {
    console.error('identity: startup failed; check dependencies and configuration');
    process.exit(1);
  });
