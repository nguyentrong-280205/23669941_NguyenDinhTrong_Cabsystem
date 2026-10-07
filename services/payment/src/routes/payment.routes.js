'use strict';
// Endpoint declarations. Validation schemas remain in docs/api_document/payment.
module.exports = [
  {
    method: 'post',
    path: '/api/v1/payment-callbacks',
    action: 'processCallback',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/payments',
    action: 'createPayment',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/payments/:id',
    action: 'getPayment',
    contract: 'openapi',
  },
];
