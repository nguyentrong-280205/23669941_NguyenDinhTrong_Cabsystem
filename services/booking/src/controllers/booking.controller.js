'use strict';
const { toCommand, respond } = require('../../../../shared/lib/http');

// Controllers translate HTTP input/output; business rules belong to the service.
module.exports = (service) => ({
  async createBooking(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.createBooking(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async listCustomerBookings(req, res, next, operation) {
    try {
      respond(
        res,
        operation,
        await service.actions.listCustomerBookings({
          ...toCommand(req),
          params: { id: req.query.customerId },
        }),
      );
    } catch (error) {
      next(error);
    }
  },
  async listDriverOffers(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.listDriverOffers(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
  async updateOffer(req, res, next, operation) {
    try {
      const accepted = req.body.status === 'ACCEPTED';
      const result = await service.actions[accepted ? 'acceptOffer' : 'rejectOffer']({
        ...toCommand(req),
        body: {},
      });
      respond(res, operation, accepted ? result : { httpStatus: 204, body: result });
    } catch (error) {
      next(error);
    }
  },
  async cancelBooking(req, res, next, operation) {
    try {
      respond(
        res,
        operation,
        await service.actions.cancelBooking({
          ...toCommand(req),
          body: { reason: req.body.reason },
        }),
      );
    } catch (error) {
      next(error);
    }
  },
  async getOfferDeliveryContext(req, res, next, operation) {
    try {
      respond(res, operation, await service.actions.getOfferDeliveryContext(toCommand(req)));
    } catch (error) {
      next(error);
    }
  },
});
