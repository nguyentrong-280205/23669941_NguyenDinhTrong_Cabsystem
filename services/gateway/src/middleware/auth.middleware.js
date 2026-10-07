'use strict';
const C = require('../../../../shared/lib/core');
const S = require('../../../../shared/lib/security');
async function authorize(req, roles) {
  S.authenticate(req);
  C.roles(req.user, ...roles);
  const profile = await C.ipc(
    'identity',
    `/api/v1/internal/users/${encodeURIComponent(req.user.userId)}/profiles`,
  );
  C.demand(
    profile.status === 'ACTIVE' && profile.registrationStatus === 'COMPLETED',
    403,
    'ACCOUNT_NOT_ACTIVE',
    'Account access is disabled',
  );
  C.context.getStore().user = req.user;
}
module.exports = { authorize };
