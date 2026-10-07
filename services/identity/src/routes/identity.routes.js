'use strict';
// Endpoint declarations. Validation schemas remain in docs/api_document/identity.
module.exports = [
  {
    method: 'post',
    path: '/api/v1/driver-otp-challenges',
    action: 'requestDriverOtp',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/customers/register',
    action: 'registerCustomer',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/driver-otp-verifications',
    action: 'verifyDriverOtp',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/drivers/register',
    action: 'registerDriver',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/customers/login',
    action: 'loginCustomer',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/drivers/login',
    action: 'loginDriver',
    contract: 'openapi',
  },
  {
    method: 'post',
    path: '/api/v1/admin/login',
    action: 'loginAdmin',
    contract: 'openapi',
  },
  {
    method: 'get',
    path: '/api/v1/internal/users/:userId/profiles',
    action: 'getUserProfile',
    contract: 'internal',
    callers: ['customer', 'driver', 'gateway'],
  },
  {
    method: 'patch',
    path: '/api/v1/internal/users/:userId',
    action: 'updateUser',
    contract: 'internal',
    callers: ['customer', 'driver'],
  },
];
