'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async createPayment(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createPayment(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async processCallback(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.processCallback(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getPayment(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getPayment(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
