'use strict';
// Runs through the Gateway against real containers. Requires demo seed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.GATEWAY_URL || 'http://localhost:8080';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function request(method,route,body,token,headers={}) {
  const r = await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:r.status,body:await r.json()};
}
async function login(email) {
  const route = email.startsWith('admin@') ? '/api/v1/admin/login' : email.startsWith('driver') ? '/api/v1/drivers/login' : '/api/v1/customers/login';
  const r = await request('POST',route,{email,password:'123456'});
  assert.equal(r.status,200,JSON.stringify(r));return r.body.accessToken;
}
async function main() {
  let ready;for(let i=0;i<40;i++){try{ready=await request('GET','/api/v1/ready');if(ready.status===200)break;}catch(_){}await sleep(1000);}assert.equal(ready?.status,200,JSON.stringify(ready));
  const customer = await login('customera@cab.com'), other = await login('customerb@cab.com'), admin = await login('admin@cab.com');
  assert.equal((await request('GET','/api/v1/customers/CUS-A',undefined,customer)).status,200);
  assert.equal((await request('GET','/api/v1/customers/CUS-A',undefined,other)).status,403);
  assert.equal((await request('PATCH','/api/v1/bookings/BKG-LATE',{status:'CANCELED',reason:'late'},customer)).status,409);
  const key = process.env.SMOKE_PAYMENT_KEY || 'docker-smoke-payment-v1';
  const responses = await Promise.all([1,2].map(()=>request('POST','/api/v1/payments',{tripId:'TRIP-A-1',method:'ELECTRONIC'},customer,{'idempotency-key':key})));
  assert.ok(responses.every(r=>r.status===202),JSON.stringify(responses));
  const paymentId = responses[0].body.paymentId;assert.equal(responses[1].body.paymentId,paymentId);
  let result;
  for (let i=0;i<30;i++) { result=await request('GET',`/api/v1/payments/${paymentId}`,undefined,customer);if(result.body.status==='COMPLETED')break;await sleep(1000); }
  assert.equal(result.body.status,'COMPLETED',JSON.stringify(result));
  for(let i=0;i<30;i++){const trip=await request('GET','/api/v1/trips/TRIP-A-1',undefined,customer);if(trip.body.paymentStatus==='PAID')break;if(i===29)assert.fail(JSON.stringify(trip));await sleep(1000);}
  assert.equal((await request('GET',`/api/v1/payments/${paymentId}`,undefined,other)).status,403);
  assert.equal((await request('POST','/api/v1/payment-callbacks',{paymentId,status:'COMPLETED',amount:50000,currency:'VND',providerTransactionId:crypto.randomUUID()})).status,401);
  assert.equal((await request('GET','/api/v1/sandbox-messages',undefined,customer)).status,403);
  assert.equal((await request('GET','/api/v1/sandbox-messages',undefined,admin)).status,200);
  if (process.env.SMOKE_FULL === 'true') {
    const driver = await login('driver1@cab.com');
    assert.equal((await request('PATCH','/api/v1/drivers/me',{availabilityStatus:'AVAILABLE'},driver)).status,200);
    assert.equal((await request('POST','/api/v1/drivers/me/locations',{latitude:10.7769,longitude:106.7009,recordedAt:new Date().toISOString()},driver)).status,200);
    const booking=await request('POST','/api/v1/bookings',{pickup:{lat:10.7769,lng:106.7009,address:'Smoke pickup'},destination:{lat:10.7779,lng:106.7019,address:'Smoke destination'},vehicleTypeId:'VT-4SEATS'},customer);
    assert.equal(booking.status,201,JSON.stringify(booking));
    let offer;
    for(let i=0;i<30;i++){const offers=await request('GET','/api/v1/booking-offers',undefined,driver);offer=offers.body.items?.find(o=>o.bookingId===booking.body.bookingId);if(offer)break;await sleep(1000);}
    assert.ok(offer,'Kafka matching did not create offer');
    const accepted=await request('PATCH',`/api/v1/booking-offers/${offer.offerId}`,{status:'ACCEPTED'},driver);assert.equal(accepted.status,200,JSON.stringify(accepted));
    const id=accepted.body.tripId;
    for(const status of ['DRIVER_ARRIVED','PICKED_UP','IN_PROGRESS'])assert.equal((await request('PATCH',`/api/v1/trips/${id}`,{status},driver)).status,200);
    const recorded=Date.now();
    for(const [offset,lng]of [[0,106.7009],[5000,106.7019]]){const location=await request('POST',`/api/v1/trips/${id}/locations`,{latitude:10.7769,longitude:lng,recordedAt:new Date(recorded+offset).toISOString()},driver);assert.equal(location.status,201,JSON.stringify(location));}
    assert.equal((await request('PATCH',`/api/v1/trips/${id}`,{status:'COMPLETED'},driver)).status,200);
    const fare=await request('GET',`/api/v1/trips/${id}/fares`,undefined,customer);assert.equal(fare.status,200,JSON.stringify(fare));assert.ok(fare.body.totalAmount>15000);
    for(let i=0;i<30;i++){const row=await request('GET','/api/v1/drivers/DRV-1',undefined,driver);if(row.body.availabilityStatus==='AVAILABLE')break;if(i===29)assert.fail('Driver not released by trip.completed');await sleep(1000);}
    console.log('PASS: real Kafka matching -> assignment -> tracking -> Fare -> Driver release');
  }
  console.log(JSON.stringify({status:'PASS',checks:['real owner databases','ownership','late cancellation','concurrent payment idempotency','durable sandbox callback HMAC','Kafka payment.completed -> Trip PAID','callback authentication'],paymentId,key}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
