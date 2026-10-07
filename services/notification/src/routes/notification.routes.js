'use strict';
// Endpoint declarations. Validation schemas remain in docs/api_document/notification.
module.exports = [
  {
    method: 'get',
    path: '/api/v1/notifications',
    action: 'listNotifications',
    contract: 'openapi',
  },
  {
    method: 'patch',
    path: '/api/v1/notifications/:id',
    action: 'markNotificationRead',
    contract: 'openapi',
  },
];
