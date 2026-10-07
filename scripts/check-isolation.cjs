'use strict';
require('dotenv').config();
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
async function main() {
  for(const owner of ['identity','booking','payment']) {
    const config={host:process.env.DB_HOST || 'postgres',port:5432,user:`${owner}_user`,password:process.env[`${owner.toUpperCase()}_DB_PASSWORD`],database:`${owner}_db`};
    const own=new Client(config);await own.connect();await own.query('SELECT 1 FROM cab_records LIMIT 1');await own.end();
    const other=new Client({...config,database:owner==='identity'?'booking_db':'identity_db'});
    let denied=false;try{await other.connect();}catch(e){denied=e.code==='42501';}finally{await other.end().catch(()=>{});}assert.ok(denied,`${owner} must not connect to another owner DB`);
  }
  for(const owner of ['customer','driver','trip','notification']) {
    const uri=`mongodb://${owner}_user:${encodeURIComponent(process.env[`${owner.toUpperCase()}_DB_PASSWORD`])}@mongodb:27017/${owner}_db?replicaSet=rs0&authSource=${owner}_db`;
    const client=new MongoClient(uri);await client.connect();
    try { await client.db(`${owner}_db`).collection('runtime').findOne({});let denied=false;try{await client.db(owner==='customer'?'driver_db':'customer_db').collection('runtime').findOne({});}catch(e){denied=e.code===13;}assert.ok(denied,`${owner} must not read another owner DB`); }finally{await client.close();}
  }
  console.log('PASS: all 7 owner accounts can access their own DB and are denied access to other owner DBs.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
