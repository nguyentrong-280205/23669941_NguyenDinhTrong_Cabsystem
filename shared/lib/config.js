'use strict';
const path = require('node:path');
const { demand, secret } = require('./core');

function loadOwnerConfig({ owner, defaultPort, required = [] }) {
  require('dotenv').config({ path: path.resolve(__dirname, `../../services/${owner}/.env`) });
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
  process.env.SERVICE_NAME = owner;
  for (const key of [
    'JWT_SECRET',
    'REGISTRATION_SECRET',
    'OTP_SECRET',
    'ENCRYPTION_KEY',
    'SERVICE_TOKEN',
  ])
    secret(key);
  for (const key of required) {
    demand(process.env[key], 500, 'CONFIGURATION_ERROR', `${owner}: ${key} is required`);
    if (key.endsWith('_SECRET')) secret(key);
  }
  const port = Number(
    process.env[`${owner.toUpperCase()}_PORT`] || process.env.PORT || defaultPort,
  );
  demand(
    Number.isInteger(port) && port > 0 && port <= 65535,
    500,
    'CONFIGURATION_ERROR',
    'Invalid service port',
  );
  return { owner, port };
}
module.exports = { loadOwnerConfig };
