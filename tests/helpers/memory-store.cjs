'use strict';
// Deterministic transactional double; real persistence/replica-set checks are separate integration tests.
module.exports = function memoryStore() {
  let records = new Map(), tail = Promise.resolve();
  const key = (collection,id) => `${collection}:${id}`;
  const api = snapshot => ({
    async get(collection,id) { const row=snapshot.get(key(collection,id)); return row ? structuredClone(row) : null; },
    async list(collection,filter={}) { return [...snapshot.entries()].filter(([k,v])=>k.startsWith(`${collection}:`) && Object.entries(filter).every(([field,expected])=>field.split('.').reduce((p,s)=>p?.[s],v)===expected)).map(([,v])=>structuredClone(v)); },
    async create(collection,id,data) { if (snapshot.has(key(collection,id))) { const e=new Error('duplicate key'); e.code=11000; throw e; } snapshot.set(key(collection,id),structuredClone(data)); return data; },
    async put(collection,id,data) { snapshot.set(key(collection,id),structuredClone(data)); return data; },
    async remove(collection,id) { snapshot.delete(key(collection,id)); }
  });
  return { async ping() {}, async close() {}, get(...args) {return api(records).get(...args);}, list(...args){return api(records).list(...args);},
    async tx(fn) { const previous=tail; let release; tail=new Promise(resolve=>{release=resolve;}); await previous;
      const snapshot=structuredClone(records); try { const result=await fn(api(snapshot)); records=snapshot; return result; } finally { release(); }
    },
    async nearby(filter,lat,lng,radius) { const rows=await api(records).list('drivers',filter); const distance=require('../../services/trip/src/services/trip.service').distance; return rows.filter(d=>d.position).map(d=>({...d,distanceMeters:distance({latitude:lat,longitude:lng},d.location)*1000})).filter(d=>d.distanceMeters<=radius*1000).sort((a,b)=>a.distanceMeters-b.distanceMeters); }
  };
};
