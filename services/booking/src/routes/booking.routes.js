'use strict';
module.exports = [
  {
    method: 'get',
    path: '/api/v1/booking-offers',
    action: 'listDriverOffers',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/bookings',
    action: 'createBooking',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/bookings',
    action: 'listCustomerBookings',
    contract: 'openapi',
  },
  {
    method: 'patch',
    path: '/api/v1/bookings/:id',
    action: 'cancelBooking',
    contract: 'openapi',
  },
  {
    method: 'patch',
    path: '/api/v1/booking-offers/:id',
    action: 'updateOffer',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/internal-offers/:id/delivery-contexts',
    action: 'getOfferDeliveryContext',
    contract: 'internal',
    callers: ['notification'],
  },
];
