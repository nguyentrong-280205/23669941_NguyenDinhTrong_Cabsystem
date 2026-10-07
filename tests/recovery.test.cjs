'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const memoryStore = require('./helpers/memory-store.cjs');
const C = require('../shared/lib/core');

test('completion releases assignment even when Fare needs reconciliation; retry never changes ready Fare', async () => {
  const store = memoryStore(), domain = require('../services/trip/src/index')(store);
  const trip = { tripId:'RECOVERY', bookingId:'B-RECOVERY', assignmentId:'A-RECOVERY', driverId:'D-RECOVERY', customerId:'C-RECOVERY', status:'IN_PROGRESS', activated:true, paymentStatus:'UNPAID', startedAt:C.now(), distanceKm:0, version:1 };
  await store.tx(tx=>tx.create('trips',trip.tripId,trip));
  await C.context.run({service:'trip'},async () => {
    const result = await domain.actions.updateTripStatus({params:{id:trip.tripId},body:{status:'COMPLETED'},user:{role:'DRIVER',driverId:trip.driverId}});
    assert.equal(result.status,'COMPLETED');
    assert.equal((await store.get('trips',trip.tripId)).fareStatus,'PENDING');
    assert.equal((await store.list('outbox'))[0].event.eventType,'trip.completed');
    await domain.tick();
    assert.equal((await store.get('trips',trip.tripId)).fare,undefined);
    const pending = await store.get('trips',trip.tripId);
    await store.tx(tx=>tx.put('trips',trip.tripId,{...pending,lastSample:{latitude:0,longitude:0,recordedAt:C.now()},pricingSnapshot:{pricingRuleId:'RULE',version:1,baseFare:15000,perKmRate:10000,perMinuteRate:0}}));
    await domain.tick();
    const ready = await store.get('trips',trip.tripId);
    assert.equal(ready.fareStatus,'READY');
    assert.equal(ready.fare.totalAmount,15000);
    await domain.tick();
    assert.deepEqual((await store.get('trips',trip.tripId)).fare,ready.fare);
  });
});

test('permanent delivery failure updates both delivery job and visible notification', async () => {
  const store=memoryStore(), domain=require('../services/notification/src/index')(store);
  const originalFetch=global.fetch, originalURL=process.env.NOTIFICATION_PROVIDER_URL, originalSecret=process.env.NOTIFICATION_PROVIDER_SECRET;
  process.env.NOTIFICATION_PROVIDER_URL='http://provider.test';process.env.NOTIFICATION_PROVIDER_SECRET='test-secret'.padEnd(64,'n');
  global.fetch=async()=>({ok:false,status:400,headers:new Headers()});
  try {
    await store.tx(async tx=>{await tx.create('deliveries','FAILED-JOB',{notificationId:'FAILED-JOB',type:'IN_APP',eventType:'payment.completed',payload:{},recipientId:'C',attempts:0,status:'PENDING',nextAt:C.now()});await tx.create('notifications','FAILED-JOB',{notificationId:'FAILED-JOB',status:'PENDING'});});
    await domain.tick();
    assert.equal((await store.get('deliveries','FAILED-JOB')).status,'FAILED');
    assert.equal((await store.get('notifications','FAILED-JOB')).status,'FAILED');
    await domain.tick();
    assert.equal((await store.get('deliveries','FAILED-JOB')).attempts,1);
  } finally { global.fetch=originalFetch;for(const [key,value]of [['NOTIFICATION_PROVIDER_URL',originalURL],['NOTIFICATION_PROVIDER_SECRET',originalSecret]]){if(value===undefined)delete process.env[key];else process.env[key]=value;} }
});
