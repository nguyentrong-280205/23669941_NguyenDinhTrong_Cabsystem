'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { demand } = require('./core');
// Persistence primitives only. Each process receives credentials for exactly one owner database.
function createStore(service) {
  const postgres = ['identity', 'booking', 'payment'].includes(service);
  let pool, client, database;
  const wrapMongo = (session) => ({
    async get(collection, id) {
      const row = await database.collection(collection).findOne({ _id: id }, { session });
      if (!row) return null;
      const { _id, ...data } = row;
      return data;
    },
    async list(collection, filter = {}) {
      return (await database.collection(collection).find(filter, { session }).toArray()).map(
        ({ _id, ...data }) => data,
      );
    },
    async create(collection, id, data) {
      await database.collection(collection).insertOne({ _id: id, ...data }, { session });
      return data;
    },
    async put(collection, id, data) {
      await database
        .collection(collection)
        .replaceOne({ _id: id }, { _id: id, ...data }, { upsert: true, session });
      return data;
    },
    async remove(collection, id) {
      await database.collection(collection).deleteOne({ _id: id }, { session });
    },
    async nearby(filter, latitude, longitude, radius) {
      return database
        .collection('drivers')
        .aggregate(
          [
            {
              $geoNear: {
                near: { type: 'Point', coordinates: [longitude, latitude] },
                distanceField: 'distanceMeters',
                maxDistance: radius * 1000,
                spherical: true,
                query: filter,
              },
            },
            { $project: { _id: 0 } },
          ],
          { session },
        )
        .toArray();
    },
  });
  const wrapPg = (connection) => ({
    async get(collection, id) {
      const r = await connection.query(
        'SELECT data FROM cab_records WHERE collection=$1 AND id=$2',
        [collection, id],
      );
      return r.rows[0]?.data || null;
    },
    async list(collection, filter = {}) {
      const r = await connection.query(
        'SELECT data FROM cab_records WHERE collection=$1 AND data @> $2::jsonb ORDER BY id',
        [collection, JSON.stringify(filter)],
      );
      return r.rows.map((r) => r.data);
    },
    async create(collection, id, data) {
      await connection.query(
        'INSERT INTO cab_records(collection,id,data) VALUES($1,$2,$3::jsonb)',
        [collection, id, JSON.stringify(data)],
      );
      return data;
    },
    async put(collection, id, data) {
      await connection.query(
        'INSERT INTO cab_records(collection,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data',
        [collection, id, JSON.stringify(data)],
      );
      return data;
    },
    async remove(collection, id) {
      await connection.query('DELETE FROM cab_records WHERE collection=$1 AND id=$2', [
        collection,
        id,
      ]);
    },
  });
  const store = {
    async init() {
      if (postgres) {
        const { Pool } = require('pg');
        demand(
          process.env.DB_NAME === `${service}_db`,
          500,
          'CONFIGURATION_ERROR',
          'Incorrect database owner',
        );
        pool = new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT || 5432),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
        });
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query('SELECT pg_advisory_xact_lock(619341)');
          await connection.query(
            'CREATE TABLE IF NOT EXISTS cab_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())',
          );
          if (
            !(await connection.query('SELECT 1 FROM cab_migrations WHERE name=$1', ['002_records']))
              .rowCount
          ) {
            await connection.query(
              fs.readFileSync(
                path.resolve(__dirname, `../../services/${service}/migrations/002_records.sql`),
                'utf8',
              ),
            );
            await connection.query('INSERT INTO cab_migrations(name) VALUES($1)', ['002_records']);
          }
          await connection.query('COMMIT');
        } catch (e) {
          await connection.query('ROLLBACK');
          throw e;
        } finally {
          connection.release();
        }
      } else {
        const { MongoClient } = require('mongodb');
        demand(
          process.env.MONGO_DB === `${service}_db`,
          500,
          'CONFIGURATION_ERROR',
          'Incorrect database owner',
        );
        client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        database = client.db(process.env.MONGO_DB);
        const models = require(
          path.resolve(__dirname, `../../services/${service}/src/models/index.js`),
        );
        for (const [collection, model] of Object.entries(models)) {
          const exists = await database.listCollections({ name: collection }).hasNext();
          if (!exists) await database.createCollection(collection, { validator: model.validator });
          for (const [keys, options] of model.indexes || [])
            await database.collection(collection).createIndex(keys, options);
        }
        // Fail startup on a standalone server: all owner writes depend on local transactions.
        await store.tx(async (tx) => {
          await tx.put('runtime', 'transaction-check', { checkedAt: new Date().toISOString() });
        });
      }
      await store.ping();
    },
    async ping() {
      if (postgres) await pool.query('SELECT 1');
      else await database.command({ ping: 1 });
    },
    async close() {
      if (pool) await pool.end();
      if (client) await client.close();
    },
    get(...args) {
      return (postgres ? wrapPg(pool) : wrapMongo()).get(...args);
    },
    list(...args) {
      return (postgres ? wrapPg(pool) : wrapMongo()).list(...args);
    },
    nearby(...args) {
      return wrapMongo().nearby(...args);
    },
    async tx(operation) {
      if (!postgres) {
        const session = client.startSession();
        try {
          return await session.withTransaction(() => operation(wrapMongo(session)), {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          });
        } finally {
          await session.endSession();
        }
      }
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT pg_advisory_xact_lock(619342)');
        const result = await operation(wrapPg(connection));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  return store;
}
module.exports = { createStore };
