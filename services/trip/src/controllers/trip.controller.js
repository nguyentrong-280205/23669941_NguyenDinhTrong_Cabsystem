'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async getCustomerDriverAccess(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getCustomerDriverAccess(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async createTrip(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createTrip(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getTripByAssignment(req, res, next, operation) {
    try {
      respond(
        res,
        operation,
        await service.actions.getTripByAssignment({
          ...toCommand(req),
          params: { assignmentId: req.query.assignmentId },
        }),
      );
    } catch (error) {
      next(error);
    }
  },
  async activateTrip(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.activateTrip(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async cancelTrip(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.cancelTrip(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async updateTripStatus(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.updateTripStatus(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async recordTripLocation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.recordTripLocation(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getTrip(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getTrip(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getFare(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getFare(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async createReview(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createReview(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getPaymentContext(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getPaymentContext(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
