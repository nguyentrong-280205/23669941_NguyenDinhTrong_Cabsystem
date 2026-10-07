'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async updateOwnLocation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.updateOwnLocation(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async updateDriverSuspension(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.updateDriverSuspension(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async createDriverRegistration(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createDriverRegistration(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getDriverRegistration(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getDriverRegistration(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getDriver(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getDriver(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getNearbyDrivers(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getNearbyDrivers(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getNearbyDriversInternal(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getNearbyDriversInternal(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async updateAvailability(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.updateAvailability(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async listDriverApplications(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.listDriverApplications(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async reviewDriverApplication(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.reviewDriverApplication(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async reserveDriver(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.reserveDriver(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getReservation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getReservation(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async confirmReservation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.confirmReservation(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async releaseReservation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.releaseReservation(toCommand(req)));
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
  async getDriverLocation(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getDriverLocation(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
