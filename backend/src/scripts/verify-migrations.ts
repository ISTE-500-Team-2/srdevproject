// Checks migration history and online work without changing the database.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool } from "../db.js";
import { verifyMigrationHistory } from "./migrate.js";
import { verifyOnlineMigrations } from "./online-migrations.js";

// Read-only deployment gate: never runs DDL, seed or repairs.
export async function verifyMigrations(pool: Pool) {
  await verifyMigrationHistory(pool);
  await verifyOnlineMigrations(pool);
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const pool = createPool();
  try {
    await verifyMigrations(pool);
    console.log(
      "Migration checksums and online work verified; database unchanged.",
    );
  } finally {
    await pool.end();
  }
}
