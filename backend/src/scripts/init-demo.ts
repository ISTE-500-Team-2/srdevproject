import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool, transaction } from '../db.js';
import { migrate, repositoryRoot } from './migrate.js';
import { assertDemoDatabase, seedDemo } from './seed-demo.js';

export async function initializeDemo(pool: Pool) {
  await assertDemoDatabase(pool);
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass(\'public."user"\') IS NOT NULL AS exists',
  );
  if (!rows[0]!.exists) {
    await transaction(pool, async (db) => {
      const tables = await db.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname='public'",
      );
      if (tables.rows[0]!.count !== 0)
        throw new Error(
          'Refusing to initialize a nonempty database. Use additive migrations instead.',
        );
      await db.query(
        await readFile(
          path.join(repositoryRoot, 'ddl/collaboratory-db-create.sql'),
          'utf8',
        ),
      );
    });
  }
  await migrate(pool);
  await seedDemo(pool);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const pool = createPool();
  try {
    await initializeDemo(pool);
  } finally {
    await pool.end();
  }
}
