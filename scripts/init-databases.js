'use strict';
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
async function main() {
  const client = new Client({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), user: process.env.POSTGRES_USER || 'cab_admin', password: process.env.POSTGRES_PASSWORD, database: 'postgres' });
  await client.connect();
  try { for (const owner of ['identity','booking','payment']) {
    const role = `${owner}_user`, database = `${owner}_db`, password = process.env[`${owner.toUpperCase()}_DB_PASSWORD`];
    if (!password) throw new Error(`Missing credential for ${owner}`);
    const identifiers = await client.query("SELECT quote_ident($1) AS role, quote_ident($2) AS database, quote_literal($3) AS password", [role,database,password]); const q = identifiers.rows[0];
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await client.query(`CREATE ROLE ${q.role} LOGIN PASSWORD ${q.password}`);
    if (!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) await client.query(`CREATE DATABASE ${q.database} OWNER ${q.role}`);
    await client.query(`REVOKE CONNECT ON DATABASE ${q.database} FROM PUBLIC`); await client.query(`GRANT CONNECT ON DATABASE ${q.database} TO ${q.role}`);
  } } finally { await client.end(); }
  console.log('Provisioned 3 PostgreSQL owner databases. MongoDB users/models are initialized by the replica-set bootstrap and owner startup.');
}
main().catch(() => { console.error('Database provisioning failed; check admin credentials and server availability'); process.exitCode = 1; });
