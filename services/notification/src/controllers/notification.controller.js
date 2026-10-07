'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async listNotifications(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.listNotifications(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async markNotificationRead(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.markNotificationRead(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
