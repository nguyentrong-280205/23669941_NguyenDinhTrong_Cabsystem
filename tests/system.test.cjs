'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const C = require('../shared/lib/core');
const S = require('../shared/lib/security');
const { consume } = require('../shared/lib/events');
const memoryStore = require('./helpers/memory-store.cjs');
const names=['identity','customer','driver','booking','trip','payment','notification'];
async function listen(app) { const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return { server,url:`http://127.0.0.1:${server.address().port}` }; }
test('HTTP regression and owner workflows with transactional persistence doubles', async t => {
  Object.assign(process.env,{ JWT_SECRET:'test-access-secret'.padEnd(64,'x'), REGISTRATION_SECRET:'test-registration-secret'.padEnd(64,'r'), OTP_SECRET:'test-otp-secret'.padEnd(64,'o'), ENCRYPTION_KEY:'a'.repeat(64), ENCRYPTION_KEY_VERSION:'v1', SERVICE_TOKEN:'test-service-token'.padEnd(64,'s'), PAYMENT_PROVIDER_SECRET:'test-payment-secret'.padEnd(64,'p'), NOTIFICATION_PROVIDER_SECRET:'test-notification-secret'.padEnd(64,'n') });
  process.env.SERVICE_TOKENS=JSON.stringify(Object.fromEntries([...names,'gateway'].map(n=>[n,process.env.SERVICE_TOKEN])));
  const stores={},domains={},servers=[];
  const redis={ counts:new Map(), async ping(){return 'PONG';}, async eval(_script,options){const k=options.keys[0],count=(this.counts.get(k)||0)+1;this.counts.set(k,count);return [count,60000];} };
  for (const name of names) { const store=memoryStore(),app=require(`../services/${name}/src/app`)(store);stores[name]=store;domains[name]=app.locals.components; const bound=await listen(app);process.env[`${name.toUpperCase()}_SERVICE_URL`]=bound.url;servers.push(bound.server); }
  const gateway=await listen(require('../services/gateway/src/app')(redis));servers.push(gateway.server);
  t.after(()=>{for(const s of servers){s.closeAllConnections();s.close();}});
  async function request(method,route,body,token,headers={}) { const response=await fetch(gateway.url+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:body===undefined?undefined:JSON.stringify(body)}); return { status:response.status,body:await response.json(),headers:response.headers }; }
  async function internal(service,method,route,body,caller='booking',user) { const response=await fetch(process.env[`${service.toUpperCase()}_SERVICE_URL`]+route,{method,headers:{'content-type':'application/json','x-service-name':caller,'x-service-token':process.env.SERVICE_TOKEN,...(user?{'x-user-context':JSON.stringify(user)}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()}; }
  async function drain() {
    for (let round=0;round<4;round++) for (const producer of names) for(const out of await stores[producer].list('outbox',{sent:false})) {
      for(const name of names) for(const sub of domains[name].subscriptions||[]) if(sub.topics.includes(out.topic)) await C.context.run({service:name,correlationId:out.event.correlationId},async()=>{const event=sub.prepare?await sub.prepare(out.event):out.event;await consume(stores[name],sub.group,event,sub.handler);});
      await stores[producer].tx(tx=>tx.put('outbox',out.eventId,{...out,sent:true}));
    }
  }
  const tick = name=>C.context.run({service:name},()=>domains[name].tick?.());
  const password='123456';
  let customerA,customerB,driver,adminToken,customerAToken,customerBToken,driverToken,tripId,bookingId,paymentId;
  await t.test('registration creates real Customer profiles; login resolves persisted IDs',async()=>{
    const a=await request('POST','/api/v1/customers/register',{fullName:'Customer A',email:'a@example.com',password});assert.equal(a.status,201,JSON.stringify(a));customerA=a.body;
    const b=await request('POST','/api/v1/customers/register',{fullName:'Customer B',email:'b@example.com',password});assert.equal(b.status,201);customerB=b.body;
    customerAToken=(await request('POST','/api/v1/customers/login',{email:'a@example.com',password})).body.accessToken;
    customerBToken=(await request('POST','/api/v1/customers/login',{email:'b@example.com',password})).body.accessToken;
    assert.equal(jwt.decode(customerAToken).customerId,customerA.customerId);
    assert.equal((await request('POST','/api/v1/drivers/login',{email:'a@example.com',password})).status,401);
  });
  await t.test('Customer ownership, unknown JSON fields and invalid login objects rejected',async()=>{
    assert.equal((await request('GET',`/api/v1/customers/${customerA.customerId}`,undefined,customerBToken)).status,403);
    assert.equal((await request('POST','/api/v1/customers/login',{email:{$ne:null},password})).status,400);
    assert.equal((await request('POST','/api/v1/customers/register',{fullName:'X',email:'x@example.com',password,role:'ADMIN'})).status,400);
  });
  await t.test('registration outage persists PENDING, does not report success, and recovers with same IDs',async()=>{
    const url=process.env.CUSTOMER_SERVICE_URL;process.env.CUSTOMER_SERVICE_URL='http://127.0.0.1:1';
    const response=await request('POST','/api/v1/customers/register',{fullName:'Pending',email:'pending@example.com',password});assert.equal(response.status,503);
    const user=(await stores.identity.list('users',{email:'pending@example.com'}))[0];assert.equal(user.registrationStatus,'PENDING');
    assert.equal((await request('POST','/api/v1/customers/login',{email:'pending@example.com',password})).status,403);
    process.env.CUSTOMER_SERVICE_URL=url;await tick('identity');assert.equal((await stores.identity.get('users',user.userId)).registrationStatus,'COMPLETED');
  });
  await t.test('OTP wrong attempts persist; encrypted Kafka payload; resend allowed immediately',async()=>{
    const response=await request('POST','/api/v1/driver-otp-challenges',{phone:'0901001001'});assert.equal(response.status,202);
    const challenge=await stores.identity.get('challenges',response.body.challengeId);
    const event=(await stores.identity.list('outbox')).find(o=>o.event.aggregateId===challenge.challengeId).event;
    const decrypted=C.decrypt(event.payload.encryptedPayload);assert.match(decrypted.otp,/^\d{6}$/);assert.equal(JSON.stringify(event).includes(decrypted.otp),false);
    const wrong=decrypted.otp==='123456'?'654321':'123456';assert.equal((await request('POST','/api/v1/driver-otp-verifications',{challengeId:challenge.challengeId,otp:wrong})).status,400);assert.equal((await stores.identity.get('challenges',challenge.challengeId)).attempts,1);
    assert.equal((await request('POST','/api/v1/driver-otp-challenges',{phone:'0901001002'})).status,202);
    await stores.identity.tx(tx=>tx.put('challenges',challenge.challengeId,{...challenge,attempts:1,expiresAt:'2000-01-01T00:00:00.000Z'}));
    const verified=await request('POST','/api/v1/driver-otp-verifications',{challengeId:challenge.challengeId,otp:decrypted.otp});assert.equal(verified.status,200);
    assert.equal((await request('POST','/api/v1/bookings',{pickup:{lat:0,lng:0,address:'A'},destination:{lat:0,lng:1,address:'B'},vehicleTypeId:'VT-4SEATS'},verified.body.registrationToken)).status,401);
    const reg=await request('POST','/api/v1/drivers/register',{registrationToken:verified.body.registrationToken,fullName:'Driver One',password,licenseNumber:'B2-VALID-001',vehicle:{vehicleTypeId:'VT-4SEATS',plateNumber:'51A-TEST'}});assert.equal(reg.status,201,JSON.stringify(reg));driver=reg.body;
    assert.equal((await request('POST','/api/v1/driver-otp-verifications',{challengeId:challenge.challengeId,otp:decrypted.otp})).status,400);
  });
  await t.test('driver approval and identity mapping; rejects availability before approval',async()=>{
    driverToken=(await request('POST','/api/v1/drivers/login',{phone:'0901001001',password})).body.accessToken;
    assert.equal((await request('POST','/api/v1/customers/login',{phone:'0901001001',password})).status,401);
    assert.equal((await request('PATCH','/api/v1/drivers/me',{availabilityStatus:'AVAILABLE'},driverToken)).status,409);
    const admin={userId:'ADMIN',role:'ADMIN',fullName:'Admin',email:'admin@example.com',status:'ACTIVE',registrationStatus:'COMPLETED',passwordHash:await bcrypt.hash(password,4)};await stores.identity.tx(tx=>tx.create('users',admin.userId,admin));
    const adminLogin=await request('POST','/api/v1/admin/login',{email:admin.email,password});assert.equal(adminLogin.status,200);adminToken=adminLogin.body.accessToken;assert.equal(jwt.decode(adminToken).role,'ADMIN');
    assert.equal((await request('POST','/api/v1/customers/login',{email:admin.email,password})).status,401);
    assert.equal((await internal('identity','GET',`/api/v1/internal/users/${customerA.userId}/profiles`,undefined,'gateway')).status,200);
    assert.equal((await internal('identity','GET',`/api/v1/internal-users/${customerA.userId}/profiles`,undefined,'gateway')).status,404);
    assert.equal((await request('GET',`/api/v1/internal/users/${customerA.userId}/profiles`,undefined,adminToken)).status,404);
    assert.equal((await request('GET','/api/v1/health/services',undefined,customerAToken)).status,403);
    assert.equal((await request('PATCH',`/api/v1/driver-applications/${driver.driverId}`,{decision:'REJECTED'},adminToken)).status,400);
    assert.equal((await request('PATCH',`/api/v1/driver-applications/${driver.driverId}`,{decision:'APPROVED'},adminToken)).status,200);
    assert.equal((await request('PATCH','/api/v1/drivers/me',{availabilityStatus:'AVAILABLE'},driverToken)).status,200);
    await stores.driver.tx(async tx=>{const row=await tx.get('drivers',driver.driverId);await tx.put('drivers',row.driverId,{...row,location:{locationId:'SEED-LOC',latitude:0,longitude:0.001,recordedAt:'2000-01-01T00:00:00.000Z'},position:{type:'Point',coordinates:[0.001,0]}});});
    await stores.trip.tx(tx=>tx.create('pricing','RULE',{pricingRuleId:'RULE',vehicleTypeId:'VT-4SEATS',baseFare:15000,perKmRate:10000,perMinuteRate:0,version:1,effectiveFrom:'2099-01-01T00:00:00.000Z'}));
  });
  await t.test('coordinates at zero accepted; strict input rejects bounds/fractional pagination',async()=>{
    assert.equal((await request('GET',`/api/v1/drivers/${driver.driverId}`,undefined,customerAToken)).status,403);
    assert.equal((await request('GET','/api/v1/drivers?lat=0&lng=0&radiusKm=1',undefined,customerAToken)).status,403);
    assert.equal((await request('GET','/api/v1/drivers?lat=0&lng=0&radiusKm=1',undefined,adminToken)).status,200);
    assert.equal((await request('GET','/api/v1/drivers?lat=91&lng=0',undefined,adminToken)).status,400);
    assert.equal((await request('GET','/api/v1/drivers?lat=0&lng=0&page=1.5',undefined,adminToken)).status,400);
    const made=await request('POST','/api/v1/bookings',{pickup:{lat:0,lng:0,address:'A'},destination:{lat:0,lng:0.003,address:'B'},vehicleTypeId:'VT-4SEATS'},customerAToken);assert.equal(made.status,201,JSON.stringify(made));bookingId=made.body.bookingId;
    assert.equal((await request('GET',`/api/v1/bookings?customerId=${customerA.customerId}`,undefined,customerBToken)).status,403);
  });
  await t.test('Kafka matching, recipient projection and idempotent concurrent accept',async()=>{
    await drain();await tick('booking');await drain();
    const offers=await request('GET','/api/v1/booking-offers',undefined,driverToken);assert.equal(offers.status,200,JSON.stringify(offers));assert.equal(offers.body.items.length,1);
    const o=offers.body.items[0];assert.equal(o.expiresAt,null);
    await stores.booking.tx(tx=>tx.put('offers',o.offerId,{...o,expiresAt:'2000-01-01T00:00:00.000Z'}));
    assert.equal((await request('GET','/api/v1/booking-offers',undefined,driverToken)).body.items.length,1);
assert.equal((await request('PATCH',`/api/v1/booking-offers/${o.offerId}`,{status:'ACCEPTED'},customerAToken)).status,403);
    const responses=await Promise.all([request('PATCH',`/api/v1/booking-offers/${o.offerId}`,{status:'ACCEPTED'},driverToken),request('PATCH',`/api/v1/booking-offers/${o.offerId}`,{status:'ACCEPTED'},driverToken)]);assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));tripId=responses[0].body.tripId;assert.equal(responses[1].body.tripId,tripId);assert.equal((await stores.trip.list('trips',{bookingId})).length,1);
    const notices=await request('GET','/api/v1/notifications',undefined,driverToken);assert.equal(notices.status,200,JSON.stringify(notices));assert.ok(notices.body.items.length>0);
  });
  await t.test('Driver profiles require assigned customer; staff retains full business details',async()=>{
    const path=`/api/v1/drivers/${driver.driverId}`;
    const own=await request('GET',path,undefined,customerAToken);
    assert.equal(own.status,200,JSON.stringify(own));
    assert.equal(own.body.fullName,'Driver One');
    for(const key of ['phone','email','licenseNumber','licenseCiphertext','licenseFingerprint','userId','registrationId','location','position','reservation']) assert.equal(Object.hasOwn(own.body,key),false,key);
    assert.equal((await request('GET',path,undefined,customerBToken)).status,403);
    const staff=await request('GET',path,undefined,adminToken);
    assert.equal(staff.status,200,JSON.stringify(staff));
    assert.equal(staff.body.phone,'0901001001');
    assert.equal(staff.body.licenseNumber,'B2-VALID-001');
    assert.equal(staff.body.userId,jwt.decode(driverToken).userId);
    assert.equal(Object.hasOwn(staff.body,'licenseCiphertext'),false);
    assert.equal((await request('GET',path,undefined,driverToken)).status,200);
    const anotherDriver=S.accessToken({userId:jwt.decode(driverToken).userId,role:'DRIVER',driverId:'OTHER'});
    assert.equal((await request('GET',path,undefined,anotherDriver)).status,403);
    const trip=await stores.trip.get('trips',tripId);
    for(const fields of [{activated:false},{status:'CANCELED'}]) {
      await stores.trip.tx(tx=>tx.put('trips',tripId,{...trip,...fields}));
      assert.equal((await request('GET',path,undefined,customerAToken)).status,403);
    }
    await stores.trip.tx(tx=>tx.put('trips',tripId,trip));
    assert.equal((await internal('trip','GET',`/api/v1/internal-drivers/${driver.driverId}/customer-accesses`,undefined,'booking')).status,401);
    assert.equal((await internal('trip','GET',`/api/v1/internal-drivers/${driver.driverId}/customer-accesses`,undefined,'driver')).status,400);
    const url=process.env.TRIP_SERVICE_URL;
    try {
      process.env.TRIP_SERVICE_URL='http://127.0.0.1:1';
      assert.equal((await request('GET',path,undefined,customerAToken)).status,503);
      assert.equal((await request('GET',path,undefined,adminToken)).status,200);
    } finally {process.env.TRIP_SERVICE_URL=url;}
  });
  await t.test('Trip ownership and state machine; no Fare on incomplete Trip',async()=>{
    const outsider=S.accessToken({userId:jwt.decode(driverToken).userId,role:'DRIVER',driverId:'OTHER'});
    assert.equal((await request('PATCH',`/api/v1/trips/${tripId}`,{status:'DRIVER_ARRIVED'},outsider)).status,403);
    assert.equal((await request('GET',`/api/v1/trips/${tripId}`,undefined,customerBToken)).status,403);
    assert.equal((await request('GET',`/api/v1/trips/${tripId}/fares`,undefined,customerAToken)).status,409);
    assert.equal((await request('PATCH',`/api/v1/trips/${tripId}`,{status:'COMPLETED'},driverToken)).status,409);
    for(const status of ['DRIVER_ARRIVED','PICKED_UP','IN_PROGRESS']) assert.equal((await request('PATCH',`/api/v1/trips/${tripId}`,{status},driverToken)).status,200);
    assert.equal((await request('PATCH',`/api/v1/bookings/${bookingId}`,{status:'CANCELED',reason:'late'},customerAToken)).status,409);
    assert.equal((await stores.booking.get('bookings',bookingId)).status,'DRIVER_ASSIGNED');
  });
  await t.test('tracking uses Driver owner; Fare and completion event commit together',async()=>{
    const base=Date.parse("2099-01-01T00:00:00.000Z");
    for(const [i,lng]of [[0,0.001],[1,0.002]]){const r=await request('POST',`/api/v1/trips/${tripId}/locations`,{latitude:0,longitude:lng,recordedAt:new Date(base-i*5000).toISOString()},driverToken);assert.equal(r.status,201,JSON.stringify(r));}
    const beforeReplay=(await stores.trip.get('trips',tripId)).distanceKm;
    assert.equal((await request('POST',`/api/v1/trips/${tripId}/locations`,{latitude:0,longitude:0.001,recordedAt:new Date(base).toISOString()},driverToken)).status,201);
    assert.equal((await stores.trip.get('trips',tripId)).distanceKm,beforeReplay);
    const found=await request('GET',`/api/v1/trips/${tripId}`,undefined,customerAToken);assert.equal(found.status,200,JSON.stringify(found));assert.equal(found.body.latestLocation.longitude,0.002);
    assert.equal(found.body.review,null);
    assert.equal((await request('PATCH',`/api/v1/trips/${tripId}`,{status:'COMPLETED'},driverToken)).status,200);
    await drain();assert.equal((await stores.booking.get('bookings',bookingId)).status,'COMPLETED');assert.equal((await stores.driver.get('drivers',driver.driverId)).availabilityStatus,'AVAILABLE');
    assert.equal((await request('GET',`/api/v1/drivers/${driver.driverId}`,undefined,customerAToken)).status,200);
    assert.equal((await request('GET',`/api/v1/trips/${tripId}/fares`,undefined,customerAToken)).status,200);
  });
  await t.test('fractional/duplicate reviews rejected and ownership checked',async()=>{
    assert.equal((await request('POST',`/api/v1/trips/${tripId}/reviews`,{score:4.9},customerAToken)).status,400);
    assert.equal((await request('POST',`/api/v1/trips/${tripId}/reviews`,{score:5},customerBToken)).status,403);
    assert.equal((await request('POST',`/api/v1/trips/${tripId}/reviews`,{score:5,comment:'Good'},customerAToken)).status,201);
    const reviewed=await request('GET',`/api/v1/trips/${tripId}`,undefined,customerAToken);
    assert.equal(reviewed.status,200,JSON.stringify(reviewed));
    assert.equal(reviewed.body.review.comment,'Good');
    assert.equal(reviewed.body.review.score,5);
    assert.equal(reviewed.body.review.tripId,tripId);
    assert.equal((await request('GET',`/api/v1/trips/${tripId}`,undefined,customerBToken)).status,403);
    assert.equal((await request('POST',`/api/v1/trips/${tripId}/reviews`,{score:5},customerAToken)).status,409);
  });
  await t.test('Payment fails closed on Trip outage and wrong owner; rejects client amount',async()=>{
    const url=process.env.TRIP_SERVICE_URL;process.env.TRIP_SERVICE_URL='http://127.0.0.1:1';assert.equal((await request('POST','/api/v1/payments',{tripId,method:'ELECTRONIC'},customerAToken,{'idempotency-key':'offline'})).status,503);process.env.TRIP_SERVICE_URL=url;
    assert.equal((await request('POST','/api/v1/payments',{tripId,method:'ELECTRONIC'},customerBToken,{'idempotency-key':'wrong-owner'})).status,403);
    assert.equal((await request('POST','/api/v1/payments',{tripId,method:'ELECTRONIC',amount:1},customerAToken,{'idempotency-key':'amount'})).status,400);
    assert.equal((await stores.payment.list('payments')).length,0);
  });
  await t.test('Payment same-key replay, conflicting body and different-key concurrency',async()=>{
    const body={tripId,method:'ELECTRONIC'};
    const [a,b]=await Promise.all([request('POST','/api/v1/payments',body,customerAToken,{'idempotency-key':'pay-1'}),request('POST','/api/v1/payments',body,customerAToken,{'idempotency-key':'pay-1'})]);assert.equal(a.status,202,JSON.stringify(a));assert.deepEqual(a.body,b.body);paymentId=a.body.paymentId;
    assert.equal((await request('POST','/api/v1/payments',{tripId:'OTHER',method:'ELECTRONIC'},customerAToken,{'idempotency-key':'pay-1'})).status,409);
    assert.equal((await request('POST','/api/v1/payments',body,customerAToken,{'idempotency-key':'pay-2'})).status,409);
    assert.equal((await request('POST','/api/v1/payments',body,customerBToken,{'idempotency-key':'pay-1'})).status,403);
    assert.equal((await stores.payment.list('payments')).length,1);
  });
  await t.test('callback verifies exact raw bytes, amount, dedup and terminal state; Kafka marks Trip PAID',async()=>{
    const payment=await stores.payment.get('payments',paymentId),body={paymentId,providerTransactionId:'PROVIDER-1',status:'COMPLETED',amount:payment.amount,currency:'VND'};
    assert.equal((await request('POST','/api/v1/payment-callbacks',body)).status,401);
    const wrong={...body,amount:1};assert.equal((await request('POST','/api/v1/payment-callbacks',wrong,undefined,{'x-provider-signature':C.hmac(JSON.stringify(wrong),'PAYMENT_PROVIDER_SECRET')})).status,400);
    const raw=JSON.stringify(body,null,2),response=await fetch(gateway.url+'/api/v1/payment-callbacks',{method:'POST',headers:{'content-type':'application/json','x-provider-signature':C.hmac(raw,'PAYMENT_PROVIDER_SECRET')},body:raw});assert.equal(response.status,200,await response.text());
    assert.equal((await request('POST','/api/v1/payment-callbacks',body,undefined,{'x-provider-signature':C.hmac(JSON.stringify(body),'PAYMENT_PROVIDER_SECRET')})).status,200);
    const old={...body,status:'FAILED'};assert.equal((await request('POST','/api/v1/payment-callbacks',old,undefined,{'x-provider-signature':C.hmac(JSON.stringify(old),'PAYMENT_PROVIDER_SECRET')})).status,409);
    await drain();assert.equal((await stores.trip.get('trips',tripId)).paymentStatus,'PAID');assert.equal((await stores.payment.list('callbacks')).length,1);
  });
  await t.test('Notification read is scoped; inbox dedup has no repeated effects',async()=>{
    const notices=await request('GET','/api/v1/notifications',undefined,customerAToken);assert.equal(notices.status,200,JSON.stringify(notices));assert.ok(notices.body.items.length>0);
    const n=notices.body.items[0];assert.equal((await request('PATCH',`/api/v1/notifications/${n.notificationId}`,{},customerBToken)).status,403);assert.equal((await request('PATCH',`/api/v1/notifications/${n.notificationId}`,{},customerAToken)).status,200);
    const before=(await stores.notification.list('notifications')).length,out=(await stores.trip.list('outbox')).find(o=>o.event.eventType==='trip.completed'),sub=domains.notification.subscriptions[0];
    await C.context.run({service:'notification'},async()=>consume(stores.notification,sub.group,await sub.prepare(out.event),sub.handler));assert.equal((await stores.notification.list('notifications')).length,before);
  });
  await t.test('internal caller scopes, assignment release fencing and Trip compensation tombstones',async()=>{
    assert.equal((await internal('trip','POST',`/api/v1/internal-trips/${tripId}/cancellations`,{assignmentId:'BAD',operationId:'bad',reason:'bad'},'customer')).status,401);
    const row=await stores.driver.get('drivers',driver.driverId),old='OLD';await stores.driver.tx(tx=>tx.put('drivers',row.driverId,{...row,reservation:{assignmentId:'NEW',bookingId:'NEW-B',tripId:'NEW-T',phase:'CONFIRMED'},availabilityStatus:'BUSY'}));
    assert.equal((await internal('driver','POST',`/api/v1/internal-drivers/${driver.driverId}/reservations/releases`,{assignmentId:old,tripId:'OLD-T'})).status,409);
    assert.equal((await stores.driver.get('drivers',driver.driverId)).reservation.assignmentId,'NEW');
    const req={assignmentId:'FENCED',operationId:'abort',reason:'failed assignment'};assert.equal((await internal('trip','POST','/api/v1/internal-trips/FENCED-TRIP/cancellations',req)).status,200);
    assert.equal((await internal('trip','POST','/api/v1/internal-trips',{assignmentId:'FENCED',tripId:'FENCED-TRIP',bookingId:'FENCED-BOOKING',customerId:customerA.customerId,driverId:driver.driverId,vehicleId:'V',vehicleTypeId:'VT-4SEATS',pickup:{lat:0,lng:0,address:'A'},destination:{lat:0,lng:1,address:'B'}})).status,409);
  });
  await t.test('Customer updates reach Identity with signed actor; status and Driver suspension enforce access',async()=>{
    const patch={operationId:'EDIT-A',fullName:'Updated Customer A',defaultPaymentMethod:'ELECTRONIC'};
    assert.equal((await request('PATCH',`/api/v1/customers/${customerA.customerId}`,patch,customerBToken)).status,403);
    for(let i=0;i<2;i++) assert.equal((await request('PATCH',`/api/v1/customers/${customerA.customerId}`,patch,customerAToken)).status,200);
    const profile=await request('GET',`/api/v1/customers/${customerA.customerId}`,undefined,customerAToken);assert.equal(profile.body.fullName,patch.fullName);assert.equal(profile.body.defaultPaymentMethod,'ELECTRONIC');
    assert.equal((await request('PATCH',`/api/v1/customers/${customerB.customerId}`,{operationId:'LOCK-B',status:'LOCKED'},adminToken)).status,200);
    assert.equal((await request('GET','/api/v1/notifications',undefined,customerBToken)).status,403);
    assert.equal((await request('PATCH',`/api/v1/customers/${customerB.customerId}`,{operationId:'UNLOCK-B',status:'ACTIVE'},adminToken)).status,200);
    assert.equal((await request('PATCH',`/api/v1/drivers/${driver.driverId}`,{suspended:true},adminToken)).status,200);
    assert.equal((await request('PATCH','/api/v1/drivers/me',{availabilityStatus:'AVAILABLE'},driverToken)).status,409);
  });
  await t.test('JWT tampering, locked users, spoofed identity and rate limits',async()=>{
    redis.counts.clear();
    const bad=customerAToken.slice(0,-2)+'AA';assert.equal((await request('GET','/api/v1/notifications',undefined,bad)).status,401);
    await stores.identity.tx(async tx=>{const user=await tx.get('users',customerB.userId);await tx.put('users',user.userId,{...user,status:'LOCKED'});});assert.equal((await request('GET','/api/v1/notifications',undefined,customerBToken)).status,403);
    assert.equal((await request('GET',`/api/v1/customers/${customerA.customerId}`,undefined,customerAToken,{'x-user-id':customerB.userId,'x-role':'ADMIN','x-service-token':'forged'})).status,200);
    const key=`cab:rate:booking-user:${customerA.userId}`;
    redis.counts.set(key,29);
    const body={pickup:{lat:0,lng:0,address:'A'},destination:{lat:0,lng:1,address:'B'},vehicleTypeId:'VT-4SEATS'};
    assert.equal((await request('POST','/api/v1/bookings',body,customerAToken)).status,201);
    const before=(await stores.booking.list('bookings')).length;
    const rejected=await request('POST','/api/v1/bookings',body,customerAToken);
    assert.equal(rejected.status,429);
    assert.equal(rejected.body.code,'RATE_LIMIT_EXCEEDED');
    assert.equal(rejected.headers.get('retry-after'),'60');
    assert.equal((await stores.booking.list('bookings')).length,before);
    redis.counts.set('cab:rate:ip:127.0.0.1',120);
    assert.equal((await request('GET','/api/v1/notifications',undefined,customerAToken)).status,429);
    assert.equal((await request('GET','/api/v1/health')).status,200);
    redis.counts.clear();
    assert.equal((await request('GET','/api/v1/notifications',undefined,customerAToken)).status,200);
  });
  await t.test('REST migration preserves query ownership, admin status policy and offer rejection',async()=>{
    assert.equal((await request('GET','/api/v1/ready')).status,200);
    assert.equal((await request('GET','/api/v1/health/services',undefined,adminToken)).status,200);
    assert.equal((await request('GET','/api/v1/health-checks')).status,404);
    assert.equal((await request('GET','/api/v1/bookings',undefined,customerAToken)).status,400);
    const history=await request('GET',`/api/v1/bookings?customerId=${customerA.customerId}&status=COMPLETED&page=1&limit=1`,undefined,customerAToken);
    assert.equal(history.status,200);assert.equal(history.body.items.length,1);assert.equal(history.body.items[0].status,'COMPLETED');
    assert.equal((await request('PATCH',`/api/v1/customers/${customerA.customerId}`,{operationId:'SELF-LOCK',status:'LOCKED'},customerAToken)).status,403);
    assert.equal((await request('PATCH','/api/v1/booking-offers/REST-OFFER',{status:'PENDING'},driverToken)).status,400);
    assert.equal((await request('PATCH','/api/v1/bookings/REST-BOOKING',{reason:'missing status'},customerAToken)).status,400);
    await stores.booking.tx(async tx=>{
      await tx.create('bookings','REST-BOOKING',{bookingId:'REST-BOOKING',customerId:customerA.customerId,status:'SEARCHING_DRIVER'});
      await tx.create('offers','REST-OFFER',{offerId:'REST-OFFER',bookingId:'REST-BOOKING',driverId:driver.driverId,status:'PENDING'});
    });
    const rejected=await fetch(gateway.url+'/api/v1/booking-offers/REST-OFFER',{method:'PATCH',headers:{'content-type':'application/json',authorization:`Bearer ${driverToken}`},body:JSON.stringify({status:'REJECTED'})});
    assert.equal(rejected.status,204);assert.equal(await rejected.text(),'');assert.equal((await stores.booking.get('offers','REST-OFFER')).status,'REJECTED');
    const assignedTrip=await stores.trip.get('trips',tripId);
    const tripLookup=await internal('trip','GET',`/api/v1/internal-trips?assignmentId=${encodeURIComponent(assignedTrip.assignmentId)}`);assert.equal(tripLookup.status,200);assert.equal(tripLookup.body.tripId,tripId);
    assert.equal((await internal('trip','GET','/api/v1/internal-trips?assignmentId=FENCED')).status,404);
    for(const [method,route,body] of [
      ['POST','/api/v1/sessions',{email:'a@example.com',password}],
      ['POST','/api/v1/customers',{fullName:'Old',email:'old@example.com',password}],
      ['POST','/api/v1/drivers',{fullName:'Old',phone:'0900000000',password}],
      ['GET','/api/v1/offers'],
      ['PATCH','/api/v1/offers/REST-OFFER',{status:'REJECTED'}],
    ]) assert.equal((await request(method,route,body,driverToken)).status,404,`${method} ${route}`);
    for(const route of ['/booking','/auth/login','/drivers/nearby','/api/v1/health-checks','/api/v1/booking-offers/REST-OFFER/accept'])assert.equal((await request('GET',route,undefined,customerAToken)).status,404);
  });
});
