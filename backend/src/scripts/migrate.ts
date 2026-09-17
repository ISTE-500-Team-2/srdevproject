import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, transaction } from '../db.js';

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

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
