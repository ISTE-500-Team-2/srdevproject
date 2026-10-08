import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool } from "../db.js";
import { repositoryRoot } from "./migrate.js";
// Read-only deployment gate: never runs DDL, seed or repairs.
export async function verifyMigrations(pool: Pool) {
  const directory = path.join(repositoryRoot, "database/migrations");
  const files = (await readdir(directory))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort();
  const rows = (
    await pool.query<{ name: string; checksum: string }>(
      "SELECT name,checksum FROM app_migration",
    )
  ).rows;
  for (const name of files) {
    const checksum = createHash("sha256")
      .update(await readFile(path.join(directory, name)))
      .digest("hex");
    const existing = rows.find((r) => r.name === name);
    if (!existing)
      throw Error(`Reviewed migration is required before rollout: ${name}`);
    if (existing.checksum !== checksum)
      throw Error(`Migration checksum mismatch: ${name}`);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const pool = createPool();
  try {
    await verifyMigrations(pool);
    console.log(
      "All required migration checksums verified; database unchanged.",
    );
  } finally {
    await pool.end();
  }
}
