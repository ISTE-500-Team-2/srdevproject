import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { Database } from '../../src/db.js';
import { migrate, prepareAuditMigration, repositoryRoot } from '../../src/scripts/migrate.js';
import { verifyMigrations } from '../../src/scripts/verify-migrations.js';

for (const branch of ['audit','main']) test(`merged audit migrations preserve the existing ${branch} database and checksums`, async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL configuration required.');
  const database = `arbor_audit_merge_${randomBytes(6).toString('hex')}_mvc_test`;
  const admin = new Pool(), pool = new Pool({database});
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    await pool.query(await readFile(path.join(repositoryRoot,'ddl/collaboratory-db-create.sql'),'utf8'));
    await pool.query('CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const directory = path.join(repositoryRoot,'database/migrations');
    const exclude = branch === 'audit'
      ? ['015_certification_management.sql','016_access_audit.sql','017_training_classes.sql']
      : ['015_audit_log_hardening.sql','016_comprehensive_audit.sql'];
    for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n) && !exclude.includes(n) && n < '018').sort()) {
      const sql = await readFile(path.join(directory,name),'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO app_migration(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);
    }
    const user = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status) VALUES('Merge','Fixture','merge@example.invalid','unused','0000000000','active') RETURNING userid`)).rows[0].userid;
    await pool.query("INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason) VALUES($1,$1,'merge.fixture','user',$1,'Keep this event')",[user]);
    const events = (await pool.query('SELECT * FROM app_staff_audit ORDER BY id')).rows;
    const ledger = (await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    await migrate(pool); await verifyMigrations(pool);
    for (const row of ledger) assert.deepEqual((await pool.query('SELECT name,checksum FROM app_migration WHERE name=$1',[row.name])).rows[0],row);
    for (const row of events) {
      const updated = (await pool.query('SELECT * FROM app_staff_audit WHERE id=$1',[row.id])).rows[0];
      for (const [key,value] of Object.entries(row)) assert.deepEqual(updated[key],value);
    }
    const first = (await pool.query("SELECT id FROM app_staff_audit WHERE action='merge.fixture'")).rows[0].id;
    await assert.rejects(pool.query('DELETE FROM app_staff_audit WHERE id=$1',[first]),(e: any) => e.code === '55000');
    await assert.rejects(pool.query('TRUNCATE app_staff_audit'),(e: any) => e.code === '55000');
    const missing = await pool.query(`SELECT tablename FROM pg_tables t WHERE schemaname='public' AND tablename NOT IN ('app_staff_audit','app_migration') AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=format('public.%I',t.tablename)::regclass AND tgname='app_capture_change')`);
    assert.deepEqual(missing.rows,[]);
    await migrate(pool); await verifyMigrations(pool);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});

test('live upgrade aborts a busy reader trigger swap and builds the lease index alongside writes', async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL configuration required.');
  const database = `arbor_online_migration_${randomBytes(6).toString('hex')}_mvc_test`;
  const admin = new Pool(), pool = new Pool({ database, statement_timeout: 5_000 });
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await pool.query(await readFile(path.join(repositoryRoot, 'ddl/collaboratory-db-create.sql'), 'utf8'));
    await pool.query('CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const directory = path.join(repositoryRoot, 'database/migrations');
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < '045').sort()) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      await prepareAuditMigration(pool, name);
      await pool.query(sql);
      await pool.query('INSERT INTO app_migration(name,checksum) VALUES($1,$2)', [
        name, createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    const writeRenewal = (db: Database) => db.query(`INSERT INTO app_device_access_event
      (reader_id,request_id,target_kind,allowed,reason,expires_at,is_tap)
      VALUES('migration-reader',$1,'equipment',true,'test',now()+interval '5 seconds',false)`, [randomUUID()]);
    const setupIndex = () => pool.query(`SELECT 'app_reader_setup_one_in_progress_device'::regclass::oid AS oid`);
    const leaseIndexState = () => pool.query<{ valid: boolean }>(`SELECT indisvalid AS valid
      FROM pg_index WHERE indexrelid=to_regclass('public.app_device_event_live_leases')`);
    const oldReader = await pool.connect();
    try {
      await oldReader.query('BEGIN');
      await writeRenewal(oldReader);
      await assert.rejects(migrate(pool), { code: '55P03' });
      await writeRenewal(pool);
      assert.equal((await pool.query("SELECT 1 FROM app_migration WHERE name >= '045'")).rowCount, 0);
      const { rows: stagedSetupIndex } = await setupIndex();
      assert.equal((await leaseIndexState()).rowCount, 0);
      await oldReader.query('ROLLBACK');

      await migrate(pool);
      await verifyMigrations(pool);
      assert.deepEqual((await setupIndex()).rows, stagedSetupIndex, 'the swap uses the index prepared outside the rolled-back transaction');
      await pool.query('DROP INDEX app_device_event_live_leases');
      await assert.rejects(verifyMigrations(pool), /index is missing or invalid: app_device_event_live_leases/);

      // Force PostgreSQL to leave an invalid index by cancelling its wait for an old writer.
      await oldReader.query('BEGIN');
      await writeRenewal(oldReader);
      const builder = await pool.connect();
      try {
        await builder.query("SET statement_timeout = '500ms'");
        await assert.rejects(builder.query(`CREATE INDEX CONCURRENTLY app_device_event_live_leases
          ON app_device_access_event(expires_at) WHERE allowed AND expires_at IS NOT NULL`), { code: '57014' });
      } finally {
        builder.release(true);
      }
      assert.deepEqual((await leaseIndexState()).rows, [{ valid: false }]);
      await assert.rejects(verifyMigrations(pool), /index is missing or invalid: app_device_event_live_leases/);
      await oldReader.query('ROLLBACK');

      // Repair the invalid index first, then force a fresh build to wait on a reader write.
      await migrate(pool);
      await pool.query('DROP INDEX app_device_event_live_leases');
      await oldReader.query('BEGIN');
      await writeRenewal(oldReader);
      const building = migrate(pool);
      // Propagate errors when awaited below, even if a catalog assertion fails first.
      void building.catch(() => {});
      try {
        for (let attempt = 0; attempt < 100 && !(await leaseIndexState()).rowCount; attempt++) await delay(20);
        assert.deepEqual((await leaseIndexState()).rows, [{ valid: false }], 'the concurrent build started with a live writer');
        await writeRenewal(pool);
      } finally {
        await oldReader.query('ROLLBACK');
        await building;
      }
      await verifyMigrations(pool);
    } finally {
      oldReader.release(true);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});
