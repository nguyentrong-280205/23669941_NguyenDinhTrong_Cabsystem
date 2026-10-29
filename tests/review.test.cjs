'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const memoryStore = require('./helpers/memory-store.cjs');
const makeTrip = require('../services/trip/src/services/trip.service');
const { contract } = require('../shared/lib/contracts');

test('review PATCH preserves omitted fields and identity, escapes supplied HTML and enforces ownership', async () => {
  const store = memoryStore();
  await store.tx(tx => tx.create('trips', 'T', {
    tripId: 'T', customerId: 'C', driverId: 'D', status: 'COMPLETED',
  }));
  const actions = makeTrip(store).actions;
  const input = { params: { id: 'T' }, user: { role: 'CUSTOMER', customerId: 'C', userId: 'U' }, body: { score: 5, comment: '<b>good</b>' } };
  await assert.rejects(actions.updateReview(input), { status: 404 });
  const created = await actions.createReview(input);
  assert.equal(created.comment, '&lt;b&gt;good&lt;/b&gt;');
  const updated = await actions.updateReview({ ...input, body: { score: 4 } });
  assert.equal(updated.ratingId, created.ratingId);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.comment, created.comment);
  assert.equal(updated.score, 4);
  const escaped = await actions.updateReview({ ...input, body: { comment: "<script>alert('hack')</script>" } });
  assert.equal(escaped.comment, '&lt;script&gt;alert(&#39;hack&#39;)&lt;/script&gt;');
  assert.equal(escaped.score, 4);
  assert.deepEqual(await store.get('ratings', 'T'), escaped);
  await assert.rejects(actions.updateReview({ ...input, user: { role: 'CUSTOMER', customerId: 'OTHER' } }), { status: 403 });
  const cleared = await actions.updateReview({ ...input, body: { comment: '' } });
  assert.equal(cleared.comment, '');
  await store.tx(tx => tx.put('trips', 'T', { tripId: 'T', customerId: 'C', status: 'CANCELED' }));
  await assert.rejects(actions.updateReview(input), { status: 409 });
});

test('review PATCH contracts validate partial updates at Trip and Gateway', () => {
  for (const owner of ['trip', 'gateway']) {
    const operation = contract(owner).find(op => op.method === 'patch' && op.route === '/api/v1/trips/:id/reviews');
    assert.ok(operation);
    const validate = body => operation.validate({ body, params: { id: 'T' }, headers: {}, query: {} });
    validate({ score: 1 });
    validate({ comment: '' });
    for (const body of [{}, { score: 0 }, { score: 6 }, { score: 1.5 }, { comment: null }, { unexpected: true }]) {
      assert.throws(() => validate(body), { status: 400 });
    }
  }
});
