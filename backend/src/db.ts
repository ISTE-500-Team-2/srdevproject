import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { auditContext } from './auditContext.js';

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function createPool(): Pool {
  const configuredMax = process.env.ARBOR_DB_POOL_MAX ?? '10';
  if (!/^[1-9]\d?$/.test(configuredMax) || Number(configuredMax) > 30)
    throw new Error('ARBOR_DB_POOL_MAX must be an integer from 1 to 30');
  return new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {}),
    max: Number(configuredMax),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    application_name: 'collaboratory-mvc',
  });
}

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
