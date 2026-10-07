'use strict';
// Endpoint declarations. Validation schemas remain in docs/api_document/trip.
module.exports = [
  {
    method: 'get',
    path: '/api/v1/internal-drivers/:id/customer-accesses',
    action: 'getCustomerDriverAccess',
    contract: 'internal',
    callers: ['driver'],
  },
  {
    method: 'post',
    path: '/api/v1/trips/:id/locations',
    action: 'recordTripLocation',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/trips/:id/reviews',
    action: 'createReview',
    contract: 'openapi',
  },
  {
    method: 'patch',
    path: '/api/v1/trips/:id',
    action: 'updateTripStatus',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/trips/:id/fares',
    action: 'getFare',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/trips/:id',
    action: 'getTrip',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/internal-trips',
    action: 'createTrip',
    contract: 'internal',
    callers: ['booking'],
  },
  {
    method: 'get',
    path: '/api/v1/internal-trips',
    action: 'getTripByAssignment',
    contract: 'internal',
    callers: ['booking'],
  },
  {
    method: 'get',
    path: '/api/v1/internal-trips/:id/payment-contexts',
    action: 'getPaymentContext',
    contract: 'internal',
    callers: ['payment'],
  },
  {
    method: 'post',
    path: '/api/v1/internal-trips/:id/activations',
    action: 'activateTrip',
    contract: 'internal',
    callers: ['booking'],
  },
  {
    method: 'post',
    path: '/api/v1/internal-trips/:id/cancellations',
    action: 'cancelTrip',
    contract: 'internal',
    callers: ['booking'],
  },
];
