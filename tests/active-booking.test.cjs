'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/lib/core');
const memoryStore = require('./helpers/memory-store.cjs');
const makeBooking = require('../services/booking/src/services/booking.service');

test('one active Booking per customer, including concurrent requests and service recreation', async () => {
  const original = C.ipc;
  C.ipc = async (_owner, path) => {
    const customerId = path.split('/').pop();
    return { customerId, userId: `U-${customerId}` };
  };
  try {
    const store = memoryStore();
    const input = customerId => ({ user: { customerId, userId: `U-${customerId}` }, body: { vehicleTypeId: 'VT-4SEATS' } });
    const actions = makeBooking(store).actions;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => actions.createBooking(input('A'))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const result of results.filter(r => r.status === 'rejected')) {
      assert.equal(result.reason.status, 429);
      assert.equal(result.reason.code, 'ACTIVE_BOOKING_EXISTS');
    }
    assert.equal((await store.list('bookings')).length, 1);
    await actions.createBooking(input('B'));
    const booking = (await store.list('bookings', { customerId: 'A' }))[0];
    for (const status of ['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'PICKED_UP', 'IN_PROGRESS']) {
      await store.tx(tx => tx.put('bookings', booking.bookingId, { ...booking, status }));
      await assert.rejects(makeBooking(store).actions.createBooking(input('A')), { status: 429, code: 'ACTIVE_BOOKING_EXISTS' });
    }
    for (const status of ['CANCELED', 'COMPLETED', 'NO_DRIVER_FOUND']) {
      for (const row of await store.list('bookings', { customerId: 'A' })) {
        await store.tx(tx => tx.put('bookings', row.bookingId, { ...row, status }));
      }
      assert.equal((await actions.createBooking(input('A'))).status, 'SEARCHING_DRIVER');
    }
  } finally {
    C.ipc = original;
  }
});
