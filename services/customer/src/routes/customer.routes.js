'use strict';
module.exports = [
  {
    method: 'get',
    path: '/api/v1/customers/:id',
    action: 'getCustomerProfile',
    contract: 'openapi',
  },
  {
    method: 'patch',
    path: '/api/v1/customers/:id',
    action: 'updateCustomer',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/internal-customer-registrations',
    action: 'createCustomerRegistration',
    contract: 'internal',
    callers: ['identity'],
  },
  {
    method: 'get',
    path: '/api/v1/internal-customer-registrations/:registrationId',
    action: 'getCustomerRegistration',
    contract: 'internal',
    callers: ['identity'],
  },
  {
    method: 'get',
    path: '/api/v1/internal-customers/:id',
    action: 'getCustomerInternal',
    contract: 'internal',
    callers: ['booking', 'payment', 'trip', 'notification'],
  },
];
