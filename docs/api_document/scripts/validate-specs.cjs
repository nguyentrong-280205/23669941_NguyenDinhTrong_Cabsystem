const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const SwaggerParser = require('@apidevtools/swagger-parser');
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).filter(e => !['node_modules','.npm-cache','.git'].includes(e.name))
    .flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
// Convert the OpenAPI 3.0 boolean exclusive bounds to JSON Schema numeric bounds.
function normalize(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const copy = Object.fromEntries(Object.entries(value).map(([key,child])=>[key,normalize(child)]));
  for (const [exclusive,bound] of [['exclusiveMinimum','minimum'],['exclusiveMaximum','maximum']]) {
    if (typeof copy[exclusive] === 'boolean') {
      if (copy[exclusive]) { copy[exclusive] = copy[bound]; delete copy[bound]; }
      else delete copy[exclusive];
    }
  }
  return copy;
}
const ajv = new Ajv({strict:false,allErrors:true}); addFormats(ajv);
function checkData(document,schema,value,expected,label) {
  const validate = ajv.compile(normalize({...schema,components:document.components}));
  assert.equal(validate(value), expected, `${label}: ${JSON.stringify(validate.errors)}`);
}
async function main() {
  let count=0;
  for (const filename of files(root).filter(f=>f.endsWith('.json'))) {
    const d=JSON.parse(fs.readFileSync(filename,'utf8'));
    if (!d.openapi) continue;
    // Pass a copy because parser dereferences in memory.
    await SwaggerParser.validate(structuredClone(d),{resolve:{external:false}});
    count++;
    for (const pi of Object.values(d.paths)) for (const op of Object.values(pi)) {
      const media=[...Object.values(op.requestBody?.content||{}),...Object.values(op.responses).flatMap(r=>Object.values(r.content||{}))];
      for (const m of media) if(m.example!==undefined)checkData(d,m.schema,m.example,true,op.operationId+' example');
    }
  }
  const payment=read('payment/openapi.json');
  const paySchema=payment.paths['/api/v1/payments'].post.requestBody.content['application/json'].schema;
  checkData(payment,paySchema,{tripId:'TRIP-1',method:'ELECTRONIC'},true,'Payment valid');
  checkData(payment,paySchema,{tripId:'TRIP-1',method:'ELECTRONIC',amount:1},false,'Untrusted amount');
  const identity=read('identity/internal.json');
  const update=identity.paths['/api/v1/internal/users/{userId}'].patch.requestBody.content['application/json'].schema;
  checkData(identity,update,{operationId:'op-1',actorUserId:'user-1'},false,'Empty User update');
  checkData(identity,update,{operationId:'op-1',actorUserId:'user-1',fullName:'Demo'},true,'User update');
  checkData(identity,update,{operationId:'op-1',actorUserId:'user-1',phone:{$ne:null}},false,'NoSQL input object');
  checkData(identity,update,{operationId:'op-1',actorUserId:'user-1',status:'ACTIVE',role:'ADMIN'},false,'Undeclared role mutation');
  const driver=read('driver/openapi.json');
  const approval=driver.paths['/api/v1/driver-applications/{id}'].patch.requestBody.content['application/json'].schema;
  checkData(driver,approval,{decision:'REJECTED'},false,'Reject without reason');
  const trip=read('trip/openapi.json');
  checkData(trip,trip.paths['/api/v1/trips/{id}/reviews'].post.requestBody.content['application/json'].schema,{score:6},false,'Score outside range');
  checkData(trip,trip.paths['/api/v1/trips/{id}'].get.responses['200'].content['application/json'].schema,
    {tripId:'t',bookingId:'b',customerId:'c',driverId:'d',vehicleId:'v',status:'ASSIGNED',paymentStatus:'UNPAID',latestLocation:null},true,'Unavailable location');
  const kafka=new Ajv2020({strict:false,allErrors:true});addFormats(kafka);
  kafka.addSchema(read('kafka/event-envelope.schema.json'),'event-envelope.schema.json');
  const registry=read('kafka/topics.json');
  for(const topic of registry.topics)kafka.compile(read('kafka/'+topic.schema));
  const validate=kafka.compile(read('kafka/payment.events.schema.json'));
  const example=read('kafka/examples/payment.completed.json');
  assert(validate(example),JSON.stringify(validate.errors));
  assert(!validate({...example,payload:{...example.payload,amount:-1}}),'Negative payment event accepted');
  assert(!validate({...example,eventType:'trip.completed'}),'Wrong producer event accepted');
  console.log(`PASS: ${count} OpenAPI documents validated; request/response examples and boundary cases checked.`);
  console.log('PASS: JSON Schema 2020-12 for 5 Kafka topics; valid/invalid payment events checked. No backend tests run.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
