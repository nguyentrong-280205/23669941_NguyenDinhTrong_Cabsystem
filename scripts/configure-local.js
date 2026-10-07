'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const services = ['identity','customer','driver','booking','trip','payment','notification','gateway'];
const callers = { identity: ['customer','driver','gateway'], customer: ['identity','booking','payment','trip','notification'], driver: ['identity','booking','trip'], booking: ['notification'], trip: ['booking','payment','driver'], payment: [], notification: [], gateway: [] };
const filename = path.join(root, '.env');
const existing = fs.existsSync(filename) ? require('dotenv').parse(fs.readFileSync(filename)) : {};
const secrets = {};
for (const key of ['JWT_SECRET','REGISTRATION_SECRET','OTP_SECRET','ENCRYPTION_KEY','PAYMENT_PROVIDER_SECRET','NOTIFICATION_PROVIDER_SECRET','POSTGRES_PASSWORD','MONGO_ROOT_PASSWORD',...services.map(s => `${s.toUpperCase()}_SERVICE_TOKEN`),...services.filter(s => s !== 'gateway').map(s => `${s.toUpperCase()}_DB_PASSWORD`)]) {
  const old = existing[key]; secrets[key] = old && old.length >= 32 && !/your_|0123456789abcdef|cab_system/.test(old) ? old : crypto.randomBytes(32).toString('hex');
}
const shared = { ...secrets, NODE_ENV: 'development', ENCRYPTION_KEY_VERSION: existing.ENCRYPTION_KEY_VERSION || 'v1', SANDBOX_MODE: 'true', SANDBOX_URL: 'http://localhost:3090', PAYMENT_PROVIDER_URL: 'http://localhost:3090', NOTIFICATION_PROVIDER_URL: 'http://localhost:3090', GATEWAY_URL: 'http://localhost:8080', REDIS_URL: 'redis://localhost:6379', KAFKA_BOOTSTRAP_SERVERS: 'localhost:9092', DB_HOST: 'localhost', DB_PORT: '5432', POSTGRES_USER: 'cab_admin', MONGO_ROOT_USER: 'cab_root', MONGO_HOST: 'localhost:27017' };
services.forEach((s,i) => { shared[`${s.toUpperCase()}_SERVICE_URL`] = `http://localhost:${s === 'gateway' ? 8080 : 3001 + i}`; });
for (const key of Object.keys(shared)) if (!(key in secrets) && existing[key] && !/your_|replace_with|postgres_password/.test(existing[key])) shared[key] = existing[key];
fs.writeFileSync(filename, Object.entries({ ...existing,...shared }).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
for (const [i,s] of services.entries()) {
  const env = { SERVICE_NAME: s, SERVICE_TOKEN: secrets[`${s.toUpperCase()}_SERVICE_TOKEN`], SERVICE_TOKENS: JSON.stringify(Object.fromEntries(callers[s].map(c => [c, secrets[`${c.toUpperCase()}_SERVICE_TOKEN`]]))), PORT: s === 'gateway' ? '8080' : String(3001 + i) };
  if (['identity','booking','payment'].includes(s)) Object.assign(env, { DB_NAME: `${s}_db`, DB_USER: `${s}_user`, DB_PASSWORD: secrets[`${s.toUpperCase()}_DB_PASSWORD`] });
  else if (s !== 'gateway') Object.assign(env, { MONGO_DB: `${s}_db`, MONGO_URI: `mongodb://${s}_user:${secrets[`${s.toUpperCase()}_DB_PASSWORD`]}@localhost:27017/${s}_db?replicaSet=rs0&directConnection=true&authSource=${s}_db` });
  fs.writeFileSync(path.join(root, `services/${s}/.env`), Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
}
console.log('Created local configuration with generated credentials. Existing usable credentials were preserved; secrets were not printed.');
