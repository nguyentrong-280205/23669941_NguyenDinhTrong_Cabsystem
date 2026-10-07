const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const services = ['identity', 'customer', 'driver', 'booking', 'trip', 'payment', 'notification'];
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const gateway = structuredClone(read('gateway/health.json'));
gateway.info = {title:'CAB System - Gateway API',version:'2.1.0',description:'GENERATED từ gateway/health.json và <service>/openapi.json. Chạy npm --prefix docs/api_document run sync. API client/provider qua Gateway; không gồm /api/v1/internal-*. x-contract=extension là API bổ sung đề xuất.'};
delete gateway['x-persistence'];
function merge(target, name, value) {
  if (Object.hasOwn(target, name)) assert.deepEqual(target[name], value, `Shared schema/security drift: ${name}`);
  else target[name] = structuredClone(value);
}
for (const service of services) {
  const source = read(`${service}/openapi.json`);
  for (const [url, pi] of Object.entries(source.paths)) {
    assert(!url.startsWith('/api/v1/internal-') && !url.startsWith('/api/v1/internal/'), `Internal API leaked into Gateway: ${url}`);
    gateway.paths[url] ||= {};
    for (const [method, op] of Object.entries(pi)) {
      assert(!gateway.paths[url][method], `Duplicate owner for ${method.toUpperCase()} ${url}`);
      assert.equal(op['x-service-owner'], service);
      gateway.paths[url][method] = structuredClone(op);
    }
  }
  for (const [name, value] of Object.entries(source.components.schemas)) merge(gateway.components.schemas, name, value);
  for (const [name, value] of Object.entries(source.components.securitySchemes)) merge(gateway.components.securitySchemes, name, value);
}
const output = JSON.stringify(gateway, null, 2) + '\n';
const filename = path.join(root, 'gateway/openapi.json');
if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n'), output,'Gateway is out of sync. Run npm --prefix docs/api_document run sync.');
  console.log('PASS: owner APIs and generated Gateway are synchronized.');
} else {
  fs.writeFileSync(filename, output);
  console.log('SYNC: regenerated gateway/openapi.json from 7 service owners and health.json.');
}
