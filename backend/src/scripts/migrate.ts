import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, transaction, type Database } from '../db.js';

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

// Both independently deployed branches used these names. Preserve the existing
// guards under distinct names before running the other branch's unchanged SQL.
export async function prepareAuditMigration(db: Database, name: string) {
  const prefix = name === '015_audit_log_hardening.sql' ? 'legacy_audit'
    : name === '016_access_audit.sql' ? 'app_audit_log'
    : name === '016_comprehensive_audit.sql' ? 'legacy_access' : null;
  if (!prefix) return;
  const exists = await db.query("SELECT to_regclass('public.app_staff_audit') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) return;
  const triggers = name === '016_comprehensive_audit.sql'
    ? ['app_staff_audit_no_truncate']
    : ['app_staff_audit_immutable', 'app_staff_audit_no_truncate'];
  for (const trigger of triggers) {
    const result = await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='public.app_staff_audit'::regclass AND tgname=$1",[trigger]);
    if (result.rowCount) await db.query(`ALTER TRIGGER ${trigger} ON app_staff_audit RENAME TO ${prefix}_${trigger}`);
  }
  if (name !== '016_comprehensive_audit.sql') {
    for (const index of ['app_staff_audit_actor_time','app_staff_audit_action_time']) {
      const result = await db.query('SELECT to_regclass($1) IS NOT NULL AS present',[`public.${index}`]);
      if (result.rows[0]?.present) await db.query(`ALTER INDEX ${index} RENAME TO ${prefix}_${index}`);
    }
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const directory = path.join(repositoryRoot, 'database/migrations');
  const files = (await readdir(directory))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort();
  await transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('arbor-mvc-migrations'))",
    );
    await db.query(
      'CREATE TABLE IF NOT EXISTS app_migration (name TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    );
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await db.query<{ checksum: string }>(
        'SELECT checksum FROM app_migration WHERE name=$1',
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Previously applied migration changed: ${name}`);
        continue;
      }
      await prepareAuditMigration(db, name);
      await db.query(sql);
      await db.query(
        'INSERT INTO app_migration (name,checksum) VALUES ($1,$2)',
        [name, checksum],
      );
      console.log(`Applied ${name}`);
    }
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const pool = createPool();
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
