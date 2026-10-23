import type { Pool, PoolClient } from 'pg';

export class AccessDeadlineError extends Error {}

// Includes pool queue time. Destroying a timed-out connection rolls back any
// uncommitted check-in and prevents queued work from later granting access.
export async function accessTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, budgetMs = 1800): Promise<T> {
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
    client = await pool.connect();
    if (expired) { release(); throw new AccessDeadlineError(); }
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout=1500');
      await client.query('SET LOCAL lock_timeout=500');
      // Check the deadline before every query, including COMMIT.
      const db = { query: (...args: unknown[]) => {
        if (expired) return Promise.reject(new AccessDeadlineError());
        return (client!.query as Function).apply(client, args);
      }} as PoolClient;
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
