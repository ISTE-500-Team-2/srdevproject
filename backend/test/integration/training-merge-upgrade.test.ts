import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { transaction } from '../../src/db.js';
import { migrate, prepareAuditMigration, repositoryRoot } from '../../src/scripts/migrate.js';

test('upgrading main preserves configured training fees and durations and later staff edits', async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  const database = `arbor_training_merge_${randomBytes(5).toString('hex')}_mvc_test`;
  const owner = new Pool(), pool = new Pool({ database });
  let created = false;
  try {
    await owner.query(`CREATE DATABASE "${database}"`); created = true;
    const branchMigrations = new Set([
      '031_policy_scope.sql', '032_training_pricing.sql',
      '033_training_enrollment_pricing.sql', '035_merge_training_requirements.sql', '038_annual_compliance.sql',
    ]);
    await transaction(pool, async db => {
      await db.query(await readFile(path.join(repositoryRoot, 'ddl/collaboratory-db-create.sql'), 'utf8'));
      await db.query('CREATE TABLE app_migration(name TEXT PRIMARY KEY,checksum CHAR(64) NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const directory = path.join(repositoryRoot, 'database/migrations');
      for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n) && !branchMigrations.has(n)).sort()) {
        const sql = await readFile(path.join(directory, name), 'utf8');
        await prepareAuditMigration(db, name); await db.query(sql);
        await db.query('INSERT INTO app_migration(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
      }
    });
    await pool.query("INSERT INTO certifications(certid,name,description,validity_days) VALUES(999,'Existing training policy','Configured on main',180)");
    await pool.query('INSERT INTO app_training_requirement(certification_id,duration_minutes,fee_cents) VALUES(999,90,4500)');
    const checksums = (await pool.query('SELECT name,checksum FROM app_migration ORDER BY name')).rows;
    await migrate(pool);
    const course = (await pool.query('SELECT training_minutes,training_fee_cents,validity_days FROM certifications WHERE certid=999')).rows[0];
    assert.deepEqual(course, { training_minutes: 90, training_fee_cents: 4500, validity_days: 365 });
    for (const entry of checksums)
      assert.equal((await pool.query('SELECT checksum FROM app_migration WHERE name=$1', [entry.name])).rows[0].checksum, entry.checksum);
    await pool.query('UPDATE certifications SET training_minutes=120,training_fee_cents=5000 WHERE certid=999');
    await migrate(pool);
    assert.deepEqual((await pool.query('SELECT training_minutes,training_fee_cents FROM certifications WHERE certid=999')).rows[0],
      { training_minutes: 120, training_fee_cents: 5000 });
  } finally {
    await pool.end();
    if (created) await owner.query(`DROP DATABASE "${database}"`);
    await owner.end();
  }
});
