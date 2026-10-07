'use strict';
const { createStore } = require('../../../../shared/lib/store');

// This owner repository is the only persistence dependency of the service.
// The shared store implements PostgreSQL/MongoDB mechanics, not business rules.
module.exports = (store) => ({
  get(collection, id) {
    return store.get(collection, id);
  },
  list(collection, filter = {}) {
    return store.list(collection, filter);
  },
  tx(work) {
    return store.tx(work);
  },
  nearby(filter, latitude, longitude, radiusKm) {
    return store.nearby(filter, latitude, longitude, radiusKm);
  },
});
module.exports.createStore = () => createStore('driver');
