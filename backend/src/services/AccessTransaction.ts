import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../db.js';

export class AccessDeadlineError extends Error {}

// Includes pool queue time. Destroying a timed-out connection rolls back any
// uncommitted check-in and prevents queued work from later granting access.
export async function accessTransaction<T>(pool: Pool, work: (db: Database) => Promise<T>, budgetMs = 1800, prepare?: () => Promise<void>): Promise<T> {
  let client: PoolClient | undefined;
  let expired = false;
  let released = false;
  const release = (destroy = false) => {
    if (client && !released) { released = true; client.release(destroy); }
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      release(true);
      reject(new AccessDeadlineError('Access verification deadline exceeded'));
    }, budgetMs);
  });
  const operation = async () => {
    // Initialization may itself need a pool connection. Include it in the same
    // deadline without occupying the pool, and never start late decision work.
    await prepare?.();
    if (expired) throw new AccessDeadlineError();
    client = await pool.connect();
    if (expired) { release(); throw new AccessDeadlineError(); }
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout=1500');
      await client.query('SET LOCAL lock_timeout=500');
      // Check the deadline before every query, including COMMIT.
      // Query-only facade: the callback must not release or otherwise manage the client.
      const db: Database = {
        query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
          if (expired) return Promise.reject(new AccessDeadlineError());
          return client!.query<R>(text, values);
        },
      };
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      if (!expired) await client.query('ROLLBACK');
      throw error;
    } finally { release(); }
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer!); }
}
