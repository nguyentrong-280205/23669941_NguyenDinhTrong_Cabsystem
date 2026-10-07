// Dependency-free checks for CAB contracts; not a complete OpenAPI/JSON Schema validator.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).filter(e => !['node_modules', '.npm-cache', '.git'].includes(e.name)).flatMap(e => e.isDirectory()
    ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const documents = new Map(files(root).filter(f => f.endsWith('.json')).map(f => [f, JSON.parse(fs.readFileSync(f, 'utf8'))]));
function resolve(ref, current) {
  const [relative, pointer = ''] = ref.split('#');
  const file = relative ? path.resolve(path.dirname(current), relative) : current;
  assert(documents.has(file), `Missing reference file: ${ref} in ${current}`);
  let value = documents.get(file);
  if (pointer) {
    assert(pointer.startsWith('/'), `Unsupported reference: ${ref}`);
    for (const token of pointer.slice(1).split('/')) {
      const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
      assert(value && Object.hasOwn(value, key), `Unresolved reference: ${ref} in ${current}`);
      value = value[key];
    }
  }
  return {file, value};
}
function walk(value, fn) {
  if (!value || typeof value !== 'object') return;
  fn(value);
  for (const child of Object.values(value)) walk(child, fn);
}
// Check examples against the schema features used by this contract set.
function matches(value, schema, file) {
  if (schema.$ref) { const r = resolve(schema.$ref, file); return matches(value, r.value, r.file); }
  if (value === null && schema.nullable) return true;
  if (schema.allOf && !schema.allOf.every(x => matches(value, x, file))) return false;
  if (schema.anyOf && !schema.anyOf.some(x => matches(value, x, file))) return false;
  if (schema.oneOf && schema.oneOf.filter(x => matches(value, x, file)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  if (schema.type === 'number' && typeof value !== 'number') return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && (schema.exclusiveMinimum ? value <= schema.minimum : value < schema.minimum)) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) return false;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key] && !matches(child, schema.properties[key], file)) return false;
      if (schema.additionalProperties === false && !schema.properties?.[key]) return false;
    }
  }
  if (Array.isArray(value) && schema.items && !value.every(x => matches(x, schema.items, file))) return false;
  return true;
}
const apis = [...documents].filter(([, d]) => d.openapi);
let operations = 0;
for (const [file, d] of documents) {
  walk(d, x => { if (x.$ref) resolve(x.$ref, file); });
  if (!d.openapi) continue;
  assert.equal(d.openapi, '3.0.3');
  assert(d.info?.title && d.info?.version && d.paths && d.servers?.length);
  const ids = new Set();
  for (const [url, pi] of Object.entries(d.paths)) {
    assert(!url.startsWith('/api/v1/internal-users') && !url.startsWith('/api/v1/offers') && url !== '/api/v1/sessions', `Legacy route: ${url}`);
    if (url === '/api/v1/customers' || url === '/api/v1/drivers') assert(!pi.post, `Legacy registration route: ${url}`);
    assert(url.startsWith('/api/v1/'), `Unversioned API: ${url}`);
    assert(!/\/(create|get|update|delete|cancel|accept|reject|activate|confirm|release|read|nearby|by-assignment)(\/|$)/.test(url), `Action/filter in URL: ${url}`);
    const isInternal = path.basename(file) === 'internal.json';
    assert.equal(url.startsWith('/api/v1/internal-') || url.startsWith('/api/v1/internal/'), isInternal, `Wrong visibility: ${url}`);
    const templated = [...url.matchAll(/\{([^}]+)\}/g)].map(x => x[1]).sort();
    for (const [method, op] of Object.entries(pi)) {
      if (!methods.has(method)) continue;
      operations++;
      assert(op.operationId && !ids.has(op.operationId), `Duplicate/missing operationId: ${file}`);
      ids.add(op.operationId);
      assert(op.summary && op.responses && Object.keys(op.responses).some(x => /^2\d\d$/.test(x)));
      const parameters = [...(pi.parameters || []), ...(op.parameters || [])];
      const actual = parameters.filter(p => p.in === 'path');
      assert.deepEqual(actual.map(p => p.name).sort(), templated, `Path parameters: ${url}`);
      assert(actual.every(p => p.required === true));
      assert.equal(new Set(parameters.map(p => p.in + ':' + p.name)).size, parameters.length);
      for (const requirement of op.security ?? d.security ?? []) {
        for (const name of Object.keys(requirement)) assert(d.components.securitySchemes[name], `Unknown auth: ${name}`);
      }
      if (isInternal) {
        assert(op['x-callers']?.length, `Missing service caller policy: ${url}`);
        assert((op.security ?? d.security).some(x => Object.hasOwn(x, 'serviceAuth')));
      }
      const media = [...Object.values(op.requestBody?.content || {}), ...Object.values(op.responses).flatMap(r => Object.values(r.content || {}))];
      for (const m of media) if (m.example !== undefined) assert(matches(m.example, m.schema, file), `Invalid example: ${url}`);
      for (const r of Object.values(op.responses)) assert(typeof r.description === 'string');
    }
  }
}
const gatewayFile = path.join(root, 'gateway/openapi.json');
const gateway = documents.get(gatewayFile);
const owned = new Set();
const ownedOperations = new Set();
for (const [file, d] of apis) {
  if (file === gatewayFile || path.basename(file) !== 'openapi.json') continue;
  for (const [url, pi] of Object.entries(d.paths)) {
    owned.add(url);
    for (const [method, op] of Object.entries(pi)) {
      const key = `${method} ${url}`;
      assert(!ownedOperations.has(key), `Multiple public owners for ${key}`);
      ownedOperations.add(key);
      assert.deepEqual(gateway.paths[url]?.[method], op, `Gateway out of sync: ${key}`);
      assert.equal(op['x-service-owner'], path.basename(path.dirname(file)));
    }
  }
  for (const [name, schema] of Object.entries(d.components.schemas)) assert.deepEqual(gateway.components.schemas[name], schema, `Schema drift: ${name}`);
}
assert.equal(Object.keys(gateway.paths).length, owned.size + 3, 'Unexpected routes in Gateway');
const srs = fs.readFileSync(path.join(root, '../requirements/srs.md'), 'utf8');
const endpointTable = srs.slice(srs.indexOf('## 10.2 Danh mục endpoint'), srs.indexOf('## 10.3 Ví dụ'));
const expected = [...endpointTable.matchAll(/\| (GET|POST|PUT|PATCH|DELETE) (\/[^\s|]+) \|/g)];
assert(expected.length >= 23, 'SRS endpoint list missing: review validator coverage');
for (const [, method, url] of expected) assert(gateway.paths[url.split('?')[0]]?.[method.toLowerCase()], `Missing SRS endpoint: ${method} ${url}`);
const ownership = srs.slice(srs.indexOf('### 9.1.1 Bounded context'), srs.indexOf('### 9.1.2 Schema'));
const databaseOwners = [...ownership.matchAll(/^\| (Identity|Customer|Driver|Booking|Trip|Payment|Notification) \/ (\w+) \| (PostgreSQL|MongoDB) \|/gm)];
assert.equal(databaseOwners.length, 7, 'SRS database ownership table missing or changed');
for (const [, owner, database, engine] of databaseOwners) {
  for (const name of ['openapi', 'internal']) {
    const contract = documents.get(path.join(root, owner.toLowerCase(), name + '.json'));
    if (contract) {
      assert.equal(contract['x-persistence']?.engine, engine, `${owner} engine differs from SRS`);
      assert.equal(contract['x-persistence']?.database, database, `${owner} database differs from SRS`);
    }
  }
}
const design = fs.readFileSync(path.join(root, '../architecture/microservice_design.md'), 'utf8');
const ipcTable = design.slice(design.indexOf('## 10.1 Hợp đồng HTTP nội bộ'), design.indexOf('## 10.2 Kafka'));
let internalCount = 0;
for (const line of ipcTable.split('\n')) {
  const owner = line.match(/^\| [^|]+ → (Identity|Customer|Driver|Booking|Trip|Payment|Notification) \|/);
  if (!owner) continue;
  const contract = documents.get(path.join(root, owner[1].toLowerCase(), 'internal.json'));
  for (const [, method, url] of line.matchAll(/(GET|POST|PUT|PATCH|DELETE) (\/api\/v1\/internal(?:\/|-)[^\s;|]+)/g)) {
    assert(contract?.paths[url.split('?')[0]]?.[method.toLowerCase()], `Missing design IPC: ${owner[1]} ${method} ${url}`);
    internalCount++;
  }
}
assert(internalCount > 0, 'No internal APIs found in design table');
const registry = documents.get(path.join(root, 'kafka/topics.json'));
const names = new Set();
for (const topic of registry.topics) {
  assert(!names.has(topic.name)); names.add(topic.name);
  const schema = documents.get(path.join(root, 'kafka', topic.schema));
  assert(schema, `Missing event schema: ${topic.schema}`);
  const variants = schema.oneOf;
  const eventNames = variants.map(x => x.properties.eventType.const);
  const subscribed = Object.values(topic.consumerGroups).flat();
  for (const event of subscribed) assert(eventNames.includes(event), `Unknown event in registry: ${event}`);
  for (const variant of variants) {
    assert(subscribed.includes(variant.properties.eventType.const), 'Event has no declared consumer');
    assert(variant.properties.payload.required.includes(topic.partitionKey), `Missing partition key: ${topic.name}`);
  }
}
const exampleFile = path.join(root, 'kafka/examples/payment.completed.json');
const schemaFile = path.join(root, 'kafka/payment.events.schema.json');
assert(matches(documents.get(exampleFile), documents.get(schemaFile), schemaFile), 'Invalid payment event example');
console.log(`PASS: ${documents.size} JSON files, ${apis.length} OpenAPI files, ${operations} operations including Gateway copies.`);
console.log(`PASS: all ${expected.length} SRS endpoints, owner/Gateway consistency, references, security, parameters and examples.`);
console.log(`PASS: 7 database owners match SRS; ${internalCount} internal API declarations match design.`);
console.log(`PASS: ${names.size} Kafka topics and event contracts. Static checks only; no backend tests executed.`);
