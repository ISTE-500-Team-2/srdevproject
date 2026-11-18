// Database connection limits and transaction ownership. Services pass the transaction client to
// models so related writes commit together.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { auditContext } from './auditContext.js';

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Build a bounded pool from PG environment variables or DATABASE_URL; query and connection timeouts prevent
 * indefinite request waits.
 */
export function createPool(): Pool {
  const configuredMax = process.env.ARBOR_DB_POOL_MAX ?? '10';
  if (!/^[1-9]\d?$/.test(configuredMax) || Number(configuredMax) > 30)
    throw new Error('ARBOR_DB_POOL_MAX must be an integer from 1 to 30');
  const pool = new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {}),
    max: Number(configuredMax),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    application_name: 'collaboratory-mvc',
  });
  // A connection the server drops (restart, failover, terminated backend) emits 'error' on its
  // client, often twice, whether it sits idle in the pool or is checked out by a transaction or
  // background job. Node ends the process on an 'error' event nobody listens for, so every client
  // keeps a listener for life and its first error is logged. The query in flight still fails (a
  // transaction rolls back), and the pool discards the broken client and connects afresh.
  const lost = (error: Error & { code?: unknown }) =>
    console.error('Database connection lost', {
      code: typeof error.code === 'string' ? error.code : undefined,
    });
  pool.on('connect', (client) => {
    client.once('error', lost).on('error', () => {});
  });
  // pg-pool repeats an idle client's error here; the client's own listener has logged it.
  pool.on('error', () => {});
  return pool;
}

/**
 * Run related work on one connection, bind the audit actor locally, and always roll back on failure
 * and release the client.
 */
export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actorId = auditContext.getStore()?.actorId;
    // SET preserves the caller's ability to choose isolation before its first query.
    await client.query(`SET LOCAL app.actor_id = '${Number.isSafeInteger(actorId) ? actorId : ''}'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
