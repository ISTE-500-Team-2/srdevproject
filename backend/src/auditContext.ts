import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';

/** actorId is the person at the keyboard; actingForId is the member whose account staff opened. */
export const auditContext = new AsyncLocalStorage<{ actorId?: number; actingForId?: number }>();

// Standalone queries get the same transaction-local identity as service transactions.
export function auditedPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'query') return async (sql: string, values?: unknown[]) => {
        const client = await target.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.actor_id',$1,true)", [String(auditContext.getStore()?.actorId ?? '')]);
          const result = await client.query(sql, values);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
