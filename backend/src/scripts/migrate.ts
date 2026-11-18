// Applies pending numbered migrations atomically under one advisory lock, with
// online work outside the schema transaction. Stored checksums reject edits.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { auditContext } from '../auditContext.js';
import { createPool, type Database } from '../db.js';
import { finishOnlineMigrations } from './online-migrations.js';

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

async function readMigrations() {
  const directory = path.join(repositoryRoot, 'database/migrations');
  const files = (await readdir(directory))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort();
  return Promise.all(files.map(async (name) => {
    const contents = await readFile(path.join(directory, name));
    return { name, sql: contents.toString('utf8'), checksum: createHash('sha256').update(contents).digest('hex') };
  }));
}

async function pendingMigrations(db: Database, migrations: Awaited<ReturnType<typeof readMigrations>>) {
  const { rows: [history] } = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.app_migration') IS NOT NULL AS present",
  );
  const applied = history!.present
    ? (await db.query<{ name: string; checksum: string }>('SELECT name,checksum FROM public.app_migration')).rows
    : [];
  const checksums = new Map(applied.map(({ name, checksum }) => [name, checksum]));
  return migrations.filter(({ name, checksum }) => {
    const previous = checksums.get(name);
    if (previous === undefined) return true;
    if (previous !== checksum)
      throw new Error(`Migration checksum mismatch: ${name}. Previously applied migration changed.`);
    return false;
  });
}

function requireApplied(pending: Awaited<ReturnType<typeof readMigrations>>) {
  if (pending.length)
    throw new Error(`Reviewed migration is required before rollout: ${pending[0]!.name}`);
}

export async function verifyMigrationHistory(db: Database) {
  requireApplied(await pendingMigrations(db, await readMigrations()));
}

/**
 * Apply pending SQL atomically and record content hashes, then finish online work under the
 * same advisory lock. An external owner process can apply the SQL and run just the online phase.
 */
export async function migrate(pool: Pool, { finishOnlineOnly = false } = {}): Promise<void> {
  const migrations = await readMigrations();
  const db = await pool.connect();
  try {
    // Keep the same key as older runners and serialize even the concurrent DDL.
    await db.query("SELECT pg_advisory_lock(hashtext('arbor-mvc-migrations'))");
    const pending = await pendingMigrations(db, migrations);
    if (finishOnlineOnly) requireApplied(pending);

    if (pending.length) {
      await db.query('BEGIN');
      try {
        const actorId = auditContext.getStore()?.actorId;
        await db.query("SELECT set_config('app.actor_id', $1, true)", [
          Number.isSafeInteger(actorId) ? String(actorId) : '',
        ]);
        await db.query(
          'CREATE TABLE IF NOT EXISTS app_migration (name TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        );
        const firstBoundedMigration = pending.find(({ name }) => name >= '045');
        for (const migration of pending) {
          const { name, sql, checksum } = migration;
          // The setting persists through the rest of this transaction.
          if (migration === firstBoundedMigration)
            await db.query("SET LOCAL lock_timeout = '250ms'");
          await prepareAuditMigration(db, name);
          await db.query(sql);
          await db.query('INSERT INTO app_migration (name,checksum) VALUES ($1,$2)', [name, checksum]);
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      for (const { name } of pending) console.log(`Applied ${name}`);
    }

    // A retry must finish these even if all numbered migrations already committed.
    await db.query('SET statement_timeout = 0');
    await finishOnlineMigrations(db);
  } finally {
    // Closing this dedicated connection releases the session lock even after an error.
    db.release(true);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const finishOnlineOnly = args.length === 1 && args[0] === '--finish-online';
  if (args.length && !finishOnlineOnly) throw new Error('Usage: migrate.js [--finish-online]');
  const pool = createPool();
  try {
    await migrate(pool, { finishOnlineOnly });
  } finally {
    await pool.end();
  }
}
