'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const memoryStore = require('./helpers/memory-store.cjs');
const createService = require('../services/customer/src/services/customer.service');

test('customer IDs persist across restarts, concurrent registrations and retries', async () => {
  const store = memoryStore();
  const register = (service, n) => service.actions.createCustomerRegistration({
    body: { registrationId: `registration-${n}`, userId: `user-${n}` },
  });
  let service = createService(store);
  const first = await register(service, 1);
  assert.equal(first.customerId, 'CU01');
  assert.deepEqual(await register(service, 1), first);
  service = createService(store);
  const customers = await Promise.all(Array.from({ length: 100 }, (_, i) => register(service, i + 2)));
  assert.equal(customers[0].customerId, 'CU02');
  assert.equal(customers[98].customerId, 'CU100');
  assert.equal(new Set(customers.map(row => row.customerId)).size, 100);
});

test('counter initialization preserves legacy IDs and continues existing CU IDs', async () => {
  const store = memoryStore();
  await store.tx(async tx => {
    await tx.create('customers', 'legacy-uuid', { customerId: 'legacy-uuid', userId: 'old', registrationId: 'old' });
    await tx.create('customers', 'CU09', { customerId: 'CU09', userId: 'nine', registrationId: 'nine' });
  });
  const service = createService(store);
  const result = await service.actions.createCustomerRegistration({ body: { registrationId: 'new', userId: 'new' } });
  assert.equal(result.customerId, 'CU10');
  assert.equal((await store.get('customers', 'legacy-uuid')).customerId, 'legacy-uuid');
});
