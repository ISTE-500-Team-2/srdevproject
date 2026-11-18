import type { Pool } from 'pg';

/** The previous release's claim predicate and row lock from c95a2b5. */
export async function previousNotificationCandidate(pool: Pool, now: Date) {
  const { rows } = await pool.query<{ kind: string }>(`SELECT o.kind FROM app_notification_outbox o
    WHERE o.status='pending' AND o.due_at<=$1 ORDER BY o.due_at,o.id
    LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, [now]);
  return rows[0]?.kind;
}
