/** Read-only, aggregate-only evidence for a reviewed environment cutover.
 * Never imports identities, runs migrations, or prints connection strings/rows.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../db.js';

export interface EnvironmentInventory {
  version: 1;
  database: string;
  tables: Record<string, {
    rows: string;
    columns: unknown[];
    constraints: unknown[];
    indexes: unknown[];
    triggers: unknown[];
    policies: unknown[];
    rowSecurity: boolean;
  }>;
  migrations: { name: string; checksum: string }[];
}
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export async function inventory(pool: Pool, expectedDatabase: string): Promise<EnvironmentInventory> {
  if (!expectedDatabase) throw Error('Expected database is required');
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query("SET LOCAL lock_timeout='500ms'");
    await db.query("SET LOCAL row_security=off");
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    if (database !== expectedDatabase) throw Error('Connected database does not match expected database');
    const tables: EnvironmentInventory['tables'] = Object.create(null);
    const names = await db.query(`SELECT c.relname AS name, c.relrowsecurity AS "rowSecurity"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
    for (const {name, rowSecurity} of names.rows) {
      // Exact aggregate counts only; a missing SELECT permission aborts the report.
      const count = await db.query(`SELECT count(*)::text AS count FROM public.${identifier(name)}`);
      const columns = await db.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull AS "notNull", a.attidentity AS identity, a.attgenerated AS generated
        FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [`public.${identifier(name)}`]);
      const constraints = await db.query(`SELECT conname AS name, contype AS type,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=to_regclass($1) ORDER BY conname`, [`public.${identifier(name)}`]);
      const indexes = await db.query(`SELECT indexname AS name,indexdef AS definition FROM pg_indexes
        WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`, [name]);
      const triggers = await db.query(`SELECT tgname AS name,tgenabled AS enabled,
        pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid=to_regclass($1) AND NOT tgisinternal ORDER BY tgname`, [`public.${identifier(name)}`]);
      const policies = await db.query(`SELECT policyname AS name,permissive,roles,cmd,qual,with_check
        FROM pg_policies WHERE schemaname='public' AND tablename=$1 ORDER BY policyname`, [name]);
      tables[name] = {rows:count.rows[0].count,columns:columns.rows,constraints:constraints.rows,
        indexes:indexes.rows,triggers:triggers.rows,policies:policies.rows,rowSecurity};
    }
    const migrations = tables.app_migration ? (await db.query(
      'SELECT name,checksum FROM public.app_migration ORDER BY name')).rows : [];
    await db.query('ROLLBACK');
    return {version:1,database,tables,migrations};
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export function compareInventories(source: EnvironmentInventory, target: EnvironmentInventory) {
  if (source.version !== 1 || target.version !== 1) throw Error('Unsupported inventory version');
  const names = [...new Set([...Object.keys(source.tables),...Object.keys(target.tables)])].sort();
  const schema = (t: EnvironmentInventory['tables'][string]) => {
    const {rows: _rows,...rest} = t;
    return JSON.stringify(rest);
  };
  return {
    // Matching schemas/counts do NOT establish matching identities, history, keys or data.
    automaticImportAllowed: false,
    sourceDatabase: source.database, targetDatabase: target.database,
    tables: names.map(name => ({name,
      status: !source.tables[name] ? 'target-only' : !target.tables[name] ? 'source-only'
        : schema(source.tables[name]) === schema(target.tables[name]) ? 'same-schema' : 'different-schema',
      sourceRows: source.tables[name]?.rows ?? null,targetRows:target.tables[name]?.rows ?? null,
    })),
    migrationsMatch: JSON.stringify(source.migrations) === JSON.stringify(target.migrations),
  };
}

async function main(args: string[]) {
  if (args[0] === 'compare' && args.length === 3) {
    const source = JSON.parse(await readFile(args[1]!, 'utf8')) as EnvironmentInventory;
    const target = JSON.parse(await readFile(args[2]!, 'utf8')) as EnvironmentInventory;
    process.stdout.write(JSON.stringify(compareInventories(source,target),null,2)+'\n');
    return;
  }
  if (args[0] !== 'snapshot' || args[1] !== '--expect-database' || args.length !== 3)
    throw Error('Use snapshot --expect-database NAME, or compare SOURCE.json TARGET.json');
  const pool = createPool();
  try { process.stdout.write(JSON.stringify(await inventory(pool,args[2]!),null,2)+'\n'); }
  finally { await pool.end(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    // SQL errors can contain protected values; keep diagnostics deliberately generic.
    console.error('Inventory failed. Check command, expected database and read-only access; no data changed.');
    process.exitCode=1;
  });
}
