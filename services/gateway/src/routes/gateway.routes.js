'use strict';
const { contract } = require('../../../../shared/lib/contracts');
module.exports = (app, controller) => {
  // Gateway routes are generated from owner contracts; do not duplicate owner rules.
  for (const operation of contract('gateway'))
    app[operation.method](operation.route, controller.handle(operation));
  if (process.env.SANDBOX_MODE === 'true') app.get('/api/v1/sandbox-messages', controller.sandboxMessages);
};
