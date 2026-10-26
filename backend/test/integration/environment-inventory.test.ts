import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {inventory,compareInventories} from '../../src/scripts/environment-inventory.js';
const database='arbor_inventory_'+randomBytes(6).toString('hex')+'_mvc_test';
const admin=new Pool(),pool=new Pool({database});
let created=false;
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  await pool.query(`CREATE TABLE "odd""name"(id integer PRIMARY KEY, private_text text NOT NULL);
    INSERT INTO "odd""name" VALUES(1,'PRIVATE_SENTINEL_DO_NOT_EXPORT');
    CREATE TABLE app_migration(name text PRIMARY KEY,checksum text NOT NULL);
    INSERT INTO app_migration VALUES('fixture.sql',repeat('a',64));`);
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();});
test('snapshot is aggregate-only, quotes catalog identifiers, preserves data and rejects wrong DB',async()=>{
  const before=await pool.query('SELECT * FROM "odd""name"');
  const snapshot=await inventory(pool,database);
  assert.equal(snapshot.database,database);
  assert.equal(snapshot.tables['odd"name']!.rows,'1');
  assert.equal(snapshot.tables['odd"name']!.constraints.length,1);
  assert.equal(snapshot.migrations[0]!.name,'fixture.sql');
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_SENTINEL_DO_NOT_EXPORT/);
  assert.deepEqual((await pool.query('SELECT * FROM "odd""name"')).rows,before.rows);
  await assert.rejects(inventory(pool,'not_this_database'),/does not match/);
  assert.equal((await pool.query('SELECT current_setting(\'transaction_read_only\') AS value')).rows[0].value,'off',
    'read-only snapshot transaction is closed');
});
test('comparison distinguishes data counts, schema changes, missing tables and migrations without authorizing import',async()=>{
  const source=await inventory(pool,database);
  await pool.query('ALTER TABLE "odd""name" ADD COLUMN added integer; CREATE TABLE extra(id integer)');
  const target=await inventory(pool,database);
  const diff=compareInventories(source,target);
  assert.equal(diff.tables.find(t=>t.name==='odd"name')!.status,'different-schema');
  assert.equal(diff.tables.find(t=>t.name==='extra')!.status,'target-only');
  assert.equal(compareInventories(target,source).tables.find(t=>t.name==='extra')!.status,'source-only');
  const same=compareInventories(target,target);
  assert.ok(same.tables.every(t=>t.status==='same-schema'));
  assert.equal(same.automaticImportAllowed,false);
  const changed=structuredClone(target);changed.migrations[0]!.checksum='b'.repeat(64);
  assert.equal(compareInventories(target,changed).migrationsMatch,false);
});
