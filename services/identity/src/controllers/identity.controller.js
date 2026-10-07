'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async registerCustomer(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.registerCustomer(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async registerDriver(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.registerDriver(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async loginCustomer(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.login(toCommand(req), ['CUSTOMER']));
    } catch (error) {
      next(error);
    }
  },
  async loginDriver(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.login(toCommand(req), ['DRIVER']));
    } catch (error) {
      next(error);
    }
  },
  async loginAdmin(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.login(toCommand(req), ['ADMIN', 'OPERATOR']));
    } catch (error) {
      next(error);
    }
  },
  async requestDriverOtp(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.requestDriverOtp(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async verifyDriverOtp(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.verifyDriverOtp(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getUserProfile(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getUserProfile(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async updateUser(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.updateUser(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
