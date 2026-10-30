'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const memoryStore = require('./helpers/memory-store.cjs');
const C = require('../shared/lib/core');
const makeBooking = require('../services/booking/src/services/booking.service');
const { contract } = require('../shared/lib/contracts');

test('invalid booking properties never create Booking, outbox or audit records', async () => {
  const valid = {
    pickup: { lat: 10.7769, lng: 106.7009, address: 'Điểm đón' },
    destination: { lat: 10.7778, lng: 106.7015, address: 'Điểm đến' },
    vehicleTypeId: 'VT-4SEATS',
  };
  const invalid = [undefined, null, {}, { ...valid, vehicleTypeId: 'VT-001' },
    { ...valid, vehicleTypeId: 'vt-4seats' }, { ...valid, customerId: 'OTHER' }];
  for (const field of ['pickup', 'destination', 'vehicleTypeId']) {
    const body = structuredClone(valid);
    delete body[field];
    invalid.push(body);
  }
  for (const field of ['pickup', 'destination']) {
    for (const point of [null, {}, { ...valid[field], lat: 91 },
      { ...valid[field], lng: -181 }, { ...valid[field], lat: '10' },
      { ...valid[field], address: '' }, { ...valid[field], address: '   ' },
      { ...valid[field], latitude: 10 }]) {
      invalid.push({ ...valid, [field]: point });
    }
  }
  const store = memoryStore();
  const actions = makeBooking(store).actions;
  const original = C.ipc;
  let calls = 0;
  C.ipc = async () => { calls++; return { customerId: 'C', userId: 'U' }; };
  try {
    for (const body of invalid) {
      await assert.rejects(actions.createBooking({ body, user: { customerId: 'C', userId: 'U' } }), { status: 400, code: 'VALIDATION_ERROR' });
    }
    assert.equal(calls, 0);
    for (const collection of ['bookings', 'outbox', 'audit']) assert.deepEqual(await store.list(collection), []);
    const gateway = contract('gateway').find(op => op.method === 'post' && op.route === '/api/v1/bookings');
    for (const body of invalid) assert.throws(() => gateway.validate({ body, headers: {}, params: {}, query: {} }), { status: 400 });
    assert.equal((await actions.createBooking({ body: valid, user: { customerId: 'C', userId: 'U' } })).status, 'SEARCHING_DRIVER');
    assert.equal((await store.list('bookings')).length, 1);
    // Invalid data still reports 400 even when a previous active Booking exists.
    await assert.rejects(actions.createBooking({ body: invalid[3], user: { customerId: 'C', userId: 'U' } }), { status: 400 });
  } finally { C.ipc = original; }
});
