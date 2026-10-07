'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');
const { roles } = require('../../../../shared/lib/core');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async updateCustomer(req, res, next, operation) {
    try {
      if (Object.hasOwn(req.body, 'status')) roles(req.user, 'ADMIN');
      const action = Object.hasOwn(req.body, 'status') ? 'updateCustomerStatus' : 'updateCustomer';
      respond(res, operation, await service.actions[action](toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async createCustomerRegistration(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createCustomerRegistration(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getCustomerRegistration(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getCustomerRegistration(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getCustomerInternal(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getCustomerInternal(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async getCustomerProfile(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getCustomerProfile(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
