'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/lib/core');
const memoryStore = require('./helpers/memory-store.cjs');

test('nearby lists saved positions across statuses and pages; matching still requires available drivers regardless of timestamp', async () => {
  const originalIpc = C.ipc;
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalVersion = process.env.ENCRYPTION_KEY_VERSION;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.ENCRYPTION_KEY_VERSION = 'v1';
  C.ipc = async () => ({ fullName: 'Demo Driver' });
  try {
    const store = memoryStore();
    const latitudes = [10.7787, 10.7841, 10.7805, 10.7823, 10.7832, 10.7877, 10.777, 10.778];
    const statuses = ['AVAILABLE', 'AVAILABLE', 'BUSY', 'BUSY', 'SUSPENDED', 'AVAILABLE', 'OFFLINE', 'OFFLINE'];
    await store.tx(async tx => {
      for (let i = 0; i < 8; i++) {
        const driverId = `DRV-${i + 1}`;
        await tx.create('drivers', driverId, {
          driverId, userId: `USER-${i}`, approvalStatus: i < 6 ? 'APPROVED' : 'PENDING',
          availabilityStatus: statuses[i], licenseCiphertext: C.encrypt('DEMO-LICENSE'),
          position: { type: 'Point', coordinates: [106.7009, latitudes[i]] },
          location: { latitude: latitudes[i], longitude: 106.7009, recordedAt: '2020-01-01T00:00:00.000Z' },
          ...(i === 2 || i === 3 ? { reservation: { assignmentId: `A-${i}` } } : {}),
        });
      }
    });
    const repository = require('../services/driver/src/repositories/driver.repository')(store);
    const service = require('../services/driver/src/services/driver.service')(repository);
    const query = { lat: 10.7769, lng: 106.7009, radiusKm: 1, limit: 2 };
    const expected = [['DRV-7', 'DRV-8'], ['DRV-1', 'DRV-3'], ['DRV-4', 'DRV-5'], ['DRV-2'], []];
    for (let page = 1; page <= 5; page++) {
      const result = await service.actions.getNearbyDrivers({ query: { ...query, page }, user: { role: 'ADMIN' } });
      assert.equal(result.total, 7);
      assert.equal(result.page, page);
      assert.equal(result.limit, 2);
      assert.deepEqual(result.items.map(row => row.driverId), expected[page - 1]);
      assert.ok(result.items.every(row => row.distanceKm <= 1));
    }
    const busy = await service.actions.getNearbyDrivers({ query: { ...query, status: 'BUSY' }, user: { role: 'ADMIN' } });
    assert.deepEqual(busy.items.map(row => row.driverId), ['DRV-3', 'DRV-4']);
    assert.equal((await service.actions.getNearbyDriversInternal({ query })).total, 2);
    await store.tx(async tx => {
      for (const id of ['DRV-1', 'DRV-3']) {
        const row = await tx.get('drivers', id);
        await tx.put('drivers', id, { ...row, location: { ...row.location, recordedAt: C.now() } });
      }
    });
    assert.deepEqual((await service.actions.getNearbyDriversInternal({ query })).items.map(row => row.driverId), ['DRV-1', 'DRV-2']);
    await assert.rejects(service.actions.getNearbyDrivers({ query, user: { role: 'CUSTOMER' } }), { code: 'FORBIDDEN' });
  } finally {
    C.ipc = originalIpc;
    for (const [key, value] of [['ENCRYPTION_KEY', originalKey], ['ENCRYPTION_KEY_VERSION', originalVersion]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
