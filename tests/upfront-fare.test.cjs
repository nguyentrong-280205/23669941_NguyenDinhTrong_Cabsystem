'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/lib/core');
const { consume } = require('../shared/lib/events');
const memoryStore = require('./helpers/memory-store.cjs');
const makeTrip = require('../services/trip/src/index');
const makePayment = require('../services/payment/src/index');

const rule = {
  pricingRuleId: 'RULE',
  vehicleTypeId: 'VT-4SEATS',
  version: 1,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  baseFare: 15000,
  perKmRate: 10000,
  perMinuteRate: 2000,
};
const body = {
  tripId: 'T',
  bookingId: 'B',
  assignmentId: 'A',
  customerId: 'C',
  driverId: 'D',
  vehicleId: 'V',
  vehicleTypeId: 'VT-4SEATS',
  pickup: { lat: 0, lng: 0, address: 'pickup' },
  destination: { lat: 0, lng: 0.003, address: 'destination' },
};
const customer = { role: 'CUSTOMER', customerId: 'C', userId: 'U' };
const driver = { role: 'DRIVER', driverId: 'D', userId: 'UD' };
async function fixture() {
  const store = memoryStore(),
    domain = makeTrip(store);
  await store.tx((tx) => tx.create('pricing', rule.pricingRuleId, rule));
  return { store, domain };
}
async function assigned(f) {
  await f.domain.actions.createTrip({ body });
  await f.domain.actions.activateTrip({
    params: { id: 'T' },
    body: { assignmentId: 'A', operationId: 'activate' },
  });
  return f.store.get('trips', 'T');
}
const cancel = (domain) =>
  domain.actions.cancelTrip({
    params: { id: 'T' },
    body: { assignmentId: 'A', operationId: 'cancel', reason: 'test' },
  });
function paymentEvent(type, trip, paymentId = 'P') {
  return {
    eventId: C.id(),
    eventType: type,
    payload: {
      tripId: trip.tripId,
      customerId: trip.customerId,
      paymentId,
      amount: trip.fare.totalAmount,
      currency: trip.fare.currency,
    },
  };
}

test('creation freezes a single Haversine Fare, validates coordinates and pricing, handles tiny and zero routes', async () => {
  const f = await fixture();
  await Promise.all([f.domain.actions.createTrip({ body }), f.domain.actions.createTrip({ body })]);
  const trip = await f.store.get('trips', 'T');
  assert.equal((await f.store.list('trips')).length, 1);
  assert.equal(trip.status, 'ASSIGNED');
  assert.equal(trip.activated, false);
  assert.equal(trip.distanceKm, 0.333585);
  assert.equal(trip.durationMinutes, 0);
  assert.equal(trip.fareStatus, 'READY');
  assert.equal(trip.fare.totalAmount, 18336);
  assert.equal(trip.fare.baseFare, 15000);
  assert.equal(trip.fare.distanceFare, 3336);
  assert.equal(trip.fare.timeFare, 0);
  const fare = await f.domain.actions.getFare({ params: { id: 'T' }, user: customer });
  assert.deepEqual(fare, trip.fare);
  await assert.rejects(
    f.domain.actions.createTrip({
      body: { ...body, destination: { ...body.destination, lng: 1 } },
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  for (const [label, destination, expected] of [
    ['ZERO', body.pickup, 0],
    ['TINY', { lat: 0, lng: 1e-10, address: 'tiny' }, 0.000001],
  ]) {
    await f.domain.actions.createTrip({
      body: { ...body, tripId: label, bookingId: label, assignmentId: label, destination },
    });
    const t = await f.store.get('trips', label);
    assert.equal(t.distanceKm, expected);
    assert.equal(t.fare.totalAmount, 15000);
  }
  for (const point of [
    { lat: 91, lng: 0 },
    { lat: 0, lng: 181 },
    { lat: '0', lng: 0 },
    { lat: NaN, lng: 0 },
    {},
  ]) {
    await assert.rejects(
      f.domain.actions.createTrip({
        body: { ...body, tripId: 'BAD', assignmentId: 'BAD', pickup: point },
      }),
      { code: 'VALIDATION_ERROR' },
    );
    assert.equal(await f.store.get('trips', 'BAD'), null);
  }
  await assert.rejects(
    f.domain.actions.createTrip({
      body: { ...body, tripId: 'NO-RULE', assignmentId: 'NO-RULE', vehicleTypeId: 'NONE' },
    }),
    { code: 'PRICING_RULE_MISSING' },
  );
  await f.store.tx((tx) => tx.put('pricing', 'RULE', { ...rule, baseFare: -1 }));
  await assert.rejects(
    f.domain.actions.createTrip({
      body: { ...body, tripId: 'BAD-RULE', assignmentId: 'BAD-RULE' },
    }),
    { code: 'PRICING_INVALID' },
  );
});

test('prepaid Trip keeps its Fare through tracking and every lifecycle transition; paid cancellation is blocked', async () => {
  const f = await fixture(),
    trip = await assigned(f);
  const context = await f.domain.actions.getPaymentContext({
    params: { id: 'T' },
    actor: customer,
  });
  assert.equal(context.activated, true);
  assert.equal(context.fareStatus, 'READY');
  assert.equal(context.status, 'ASSIGNED');
  await assert.rejects(
    f.domain.actions.getPaymentContext({
      params: { id: 'T' },
      actor: { ...customer, customerId: 'OTHER' },
    }),
    { status: 403 },
  );
  const sub = f.domain.subscriptions[0],
    event = paymentEvent('payment.completed', trip);
  await consume(f.store, sub.group, event, sub.handler);
  await consume(f.store, sub.group, event, sub.handler);
  assert.equal((await f.store.get('trips', 'T')).paymentStatus, 'PAID');
  await assert.rejects(cancel(f.domain), { status: 409, code: 'TRIP_ALREADY_PAID' });
  await assert.rejects(
    f.domain.actions.updateTripStatus({
      params: { id: 'T' },
      user: driver,
      body: { status: 'COMPLETED' },
    }),
    { code: 'INVALID_STATUS_TRANSITION' },
  );
  const originalIPC = C.ipc;
  C.ipc = async () => ({ locationId: 'L' });
  try {
    for (const status of ['DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'PICKED_UP', 'IN_PROGRESS'])
      await f.domain.actions.updateTripStatus({
        params: { id: 'T' },
        user: driver,
        body: { status },
      });
    for (const lng of [0.001, 0.002]) {
      const sample = { latitude: 0, longitude: lng, recordedAt: C.now() };
      await f.domain.actions.recordTripLocation({
        params: { id: 'T' },
        user: driver,
        body: sample,
      });
      await f.domain.actions.recordTripLocation({
        params: { id: 'T' },
        user: driver,
        body: sample,
      });
    }
    const tracked = await f.store.get('trips', 'T');
    assert.ok(tracked.trackedDistanceKm > 0);
    assert.equal(tracked.distanceKm, trip.distanceKm);
    assert.deepEqual(tracked.fare, trip.fare);
    await f.domain.actions.updateTripStatus({
      params: { id: 'T' },
      user: driver,
      body: { status: 'COMPLETED' },
    });
    await f.domain.tick();
    const completed = await f.store.get('trips', 'T');
    assert.equal(completed.paymentStatus, 'PAID');
    assert.deepEqual(completed.fare, trip.fare);
    assert.equal(completed.distanceKm, trip.distanceKm);
    assert.equal(completed.durationMinutes, 0);
  } finally {
    C.ipc = originalIPC;
  }
});

test('payment eligibility rejects unactivated, missing Fare and canceled Trips; unpaid cancellation still works', async () => {
  const f = await fixture();
  await f.domain.actions.createTrip({ body });
  await assert.rejects(
    f.domain.actions.getPaymentContext({ params: { id: 'T' }, actor: customer }),
    { code: 'FARE_NOT_READY' },
  );
  await f.store.tx(async (tx) => {
    const trip = await tx.get('trips', 'T');
    await tx.put('trips', 'T', { ...trip, activated: true, fareStatus: 'PENDING' });
  });
  await assert.rejects(
    f.domain.actions.getPaymentContext({ params: { id: 'T' }, actor: customer }),
    { code: 'FARE_NOT_READY' },
  );
  await f.store.tx(async (tx) => {
    const trip = await tx.get('trips', 'T');
    await tx.put('trips', 'T', { ...trip, fareStatus: 'READY' });
  });
  await cancel(f.domain);
  await assert.rejects(
    f.domain.actions.getPaymentContext({ params: { id: 'T' }, actor: customer }),
    { code: 'FARE_NOT_READY' },
  );
  await assert.rejects(f.domain.actions.getFare({ params: { id: 'T' }, user: customer }), {
    code: 'FARE_NOT_READY',
  });
});

test('legacy unpaid trips obtain a quote lazily; existing and paid fares are never overwritten', async () => {
  const f = await fixture();
  await f.store.tx((tx) =>
    tx.create('trips', 'T', {
      ...body,
      status: 'IN_PROGRESS',
      activated: true,
      paymentStatus: 'UNPAID',
      distanceKm: 99,
      version: 1,
    }),
  );
  const fare = await f.domain.actions.getFare({ params: { id: 'T' }, user: customer });
  const reconciled = await f.store.get('trips', 'T');
  assert.equal(reconciled.distanceKm, 0.333585);
  await f.store.tx(async (tx) => {
    await tx.put('pricing', 'RULE', { ...rule, baseFare: 999999, version: 2 });
    await tx.put('trips', 'T', { ...reconciled, fareStatus: undefined, paymentStatus: 'PAID' });
  });
  assert.deepEqual(await f.domain.actions.getFare({ params: { id: 'T' }, user: customer }), fare);
  await f.domain.actions.updateTripStatus({
    params: { id: 'T' },
    user: driver,
    body: { status: 'COMPLETED' },
  });
  assert.deepEqual((await f.store.get('trips', 'T')).fare, fare);
  await f.store.tx(async (tx) => {
    const trip = await tx.get('trips', 'T');
    await tx.put('trips', 'T', { ...trip, fare: undefined });
  });
  await assert.rejects(f.domain.actions.getFare({ params: { id: 'T' }, user: customer }), {
    code: 'FARE_NOT_READY',
  });
  assert.equal((await f.store.get('trips', 'T')).fare, undefined);
});

test('authorization and cancellation are serialized; failures release only the matching reservation', async () => {
  const f = await fixture(),
    trip = await assigned(f);
  const input = {
    params: { id: 'T' },
    body: {
      paymentId: 'P',
      tripId: 'T',
      customerId: 'C',
      fareId: trip.fare.fareId,
      amount: trip.fare.totalAmount,
      currency: 'VND',
    },
  };
  await assert.rejects(
    f.domain.actions.authorizePayment({ ...input, body: { ...input.body, amount: 1 } }),
    { code: 'PAYMENT_CONTEXT_CHANGED' },
  );
  await f.domain.actions.authorizePayment(input);
  await f.domain.actions.authorizePayment(input);
  await assert.rejects(cancel(f.domain), { code: 'PAYMENT_IN_PROGRESS' });
  await assert.rejects(
    f.domain.actions.authorizePayment({ ...input, body: { ...input.body, paymentId: 'OTHER' } }),
    { code: 'TRIP_PAYMENT_EXISTS' },
  );
  const sub = f.domain.subscriptions[0];
  await consume(f.store, sub.group, paymentEvent('payment.failed', trip, 'OLD'), sub.handler);
  assert.equal((await f.store.get('trips', 'T')).paymentReservation.paymentId, 'P');
  await consume(f.store, sub.group, paymentEvent('payment.failed', trip), sub.handler);
  assert.equal((await f.store.get('trips', 'T')).paymentReservation, null);
  await cancel(f.domain);
  await assert.rejects(f.domain.actions.authorizePayment(input), { code: 'FARE_NOT_READY' });
});

test('a cancellation winning the race prevents a persisted payment job from charging', async () => {
  const f = await fixture(),
    trip = await assigned(f),
    paymentStore = memoryStore(),
    paymentDomain = makePayment(paymentStore);
  const originalIPC = C.ipc,
    originalFetch = global.fetch,
    providerURL = process.env.PAYMENT_PROVIDER_URL;
  process.env.PAYMENT_PROVIDER_URL = 'http://provider.test';
  let charges = 0;
  C.ipc = async (_service, route, options = {}) =>
    route.endsWith('payment-contexts')
      ? f.domain.actions.getPaymentContext({ params: { id: 'T' }, actor: options.user })
      : f.domain.actions.authorizePayment({ params: { id: 'T' }, body: options.body });
  global.fetch = async () => {
    charges++;
    throw new Error('Provider must not be called');
  };
  try {
    const input = {
      user: customer,
      headers: { 'idempotency-key': 'race' },
      body: { tripId: 'T', method: 'ELECTRONIC' },
    };
    const result = await paymentDomain.actions.createPayment(input);
    await cancel(f.domain);
    await paymentDomain.tick();
    await paymentDomain.tick();
    const payment = await paymentStore.get('payments', result.body.paymentId);
    assert.equal(payment.status, 'FAILED');
    assert.equal(charges, 0);
    assert.equal(payment.amount, trip.fare.totalAmount);
    assert.equal(
      (await paymentStore.list('outbox')).filter((o) => o.event.eventType === 'payment.failed')
        .length,
      1,
    );
    await assert.rejects(
      paymentDomain.actions.createPayment({ ...input, headers: { 'idempotency-key': 'new' } }),
      { code: 'FARE_NOT_READY' },
    );
  } finally {
    C.ipc = originalIPC;
    global.fetch = originalFetch;
    if (providerURL === undefined) delete process.env.PAYMENT_PROVIDER_URL;
    else process.env.PAYMENT_PROVIDER_URL = providerURL;
  }
});

test('lost authorization/provider responses retry the same payment without another logical charge', async () => {
  const f = await fixture(),
    trip = await assigned(f),
    paymentStore = memoryStore();
  let paymentDomain = makePayment(paymentStore);
  const originalIPC = C.ipc,
    originalFetch = global.fetch;
  const originalURL = process.env.PAYMENT_PROVIDER_URL,
    originalSecret = process.env.PAYMENT_PROVIDER_SECRET;
  process.env.PAYMENT_PROVIDER_URL = 'http://provider.test';
  process.env.PAYMENT_PROVIDER_SECRET = 'retry-secret'.padEnd(64, 'p');
  const charges = new Map();
  let lostAuthorization = true,
    lostProviderResponse = true,
    submissions = 0;
  C.ipc = async (_service, route, options = {}) => {
    if (route.endsWith('payment-contexts'))
      return f.domain.actions.getPaymentContext({ params: { id: 'T' }, actor: options.user });
    const result = await f.domain.actions.authorizePayment({
      params: { id: 'T' },
      body: options.body,
    });
    if (lostAuthorization) {
      lostAuthorization = false;
      C.fail(504, 'DEPENDENCY_UNAVAILABLE', 'Lost authorization response');
    }
    return result;
  };
  global.fetch = async (_url, options) => {
    submissions++;
    const key = options.headers['idempotency-key'],
      charge = JSON.parse(options.body);
    if (charges.has(key)) assert.deepEqual(charges.get(key), charge);
    else charges.set(key, charge);
    if (lostProviderResponse) {
      lostProviderResponse = false;
      throw new Error('Lost charge response');
    }
    return { ok: true, json: async () => ({ providerTransactionId: 'PROVIDER-RETRY' }) };
  };
  try {
    const input = {
      user: customer,
      headers: { 'idempotency-key': 'retry' },
      body: { tripId: 'T', method: 'ELECTRONIC' },
    };
    const result = await paymentDomain.actions.createPayment(input);
    await paymentDomain.tick();
    assert.equal(submissions, 0);
    await assert.rejects(cancel(f.domain), { code: 'PAYMENT_IN_PROGRESS' });
    await paymentDomain.tick();
    assert.equal(charges.size, 1);
    paymentDomain = makePayment(paymentStore); // Simulate a worker restart using the same durable jobs.
    await paymentDomain.tick();
    await paymentDomain.tick();
    assert.equal(charges.size, 1);
    assert.equal(submissions, 2);
    assert.equal(
      (await paymentStore.get('payments', result.body.paymentId)).amount,
      trip.fare.totalAmount,
    );
    assert.deepEqual(await paymentDomain.actions.createPayment(input), result);
    assert.equal((await paymentStore.list('payments')).length, 1);
    assert.equal((await paymentStore.get('attempts', result.body.paymentId)).submitted, true);
  } finally {
    C.ipc = originalIPC;
    global.fetch = originalFetch;
    for (const [key, value] of [
      ['PAYMENT_PROVIDER_URL', originalURL],
      ['PAYMENT_PROVIDER_SECRET', originalSecret],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('Booking can retry the same cancellation after payment failure releases the Trip', async () => {
  const f = await fixture(),
    trip = await assigned(f),
    bookingStore = memoryStore();
  const booking = require('../services/booking/src/index')(bookingStore),
    originalIPC = C.ipc;
  await bookingStore.tx(async (tx) => {
    await tx.create('bookings', 'B', { ...body, status: 'DRIVER_ASSIGNED', version: 1 });
    await tx.create('assignments', 'A', { assignmentId: 'A', status: 'COMPLETED' });
  });
  const authorization = {
    params: { id: 'T' },
    body: {
      paymentId: 'P',
      tripId: 'T',
      customerId: 'C',
      fareId: trip.fare.fareId,
      amount: trip.fare.totalAmount,
      currency: 'VND',
    },
  };
  await f.domain.actions.authorizePayment(authorization);
  C.ipc = async (_service, _route, options) =>
    f.domain.actions.cancelTrip({ params: { id: 'T' }, body: options.body });
  try {
    const input = { params: { id: 'B' }, user: customer, body: { reason: 'test' } };
    await assert.rejects(booking.actions.cancelBooking(input), { code: 'PAYMENT_IN_PROGRESS' });
    const sub = f.domain.subscriptions[0];
    await consume(f.store, sub.group, paymentEvent('payment.failed', trip), sub.handler);
    const canceled = await booking.actions.cancelBooking(input);
    assert.equal(canceled.status, 'CANCELED');
    assert.equal((await bookingStore.get('bookings', 'B')).status, 'CANCELED');
    assert.equal((await f.store.get('trips', 'T')).status, 'CANCELED');
    assert.deepEqual(await booking.actions.cancelBooking(input), canceled);
  } finally {
    C.ipc = originalIPC;
  }
});
