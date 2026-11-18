// Bounds the reader lease history: machine readers renew a member's lease about once a second while
// the card stays on, and every renewal is its own app_device_access_event row.

import type { Pool } from 'pg';
import { transaction } from './db.js';
import { errorIdentifier } from './logSafety.js';

export const READER_LEASE_COMPACTION_INTERVAL_MS = 60_000;

/**
 * Collapses each continuous run of granted renewals (same reader, member, card, resource and reason,
 * each starting before the run so far has expired) to its first and last rows. The first row is
 * stretched over the rows removed between them, so the run covers exactly the same time: authorized
 * hours, live-lease counts and each reader's latest activity read the same as before. Only renewals
 * that ended over ten minutes ago are touched, well past the 15-second replay window. Taps, refusals
 * and live leases are never touched, and none of these writes reach the audit log
 * (048_device_renewal_audit.sql). Each pass reads at most `batch` rows from the last `lookback` of
 * ended renewals, oldest first. The application's database role needs UPDATE and DELETE on
 * app_device_access_event (docs/prewarmed-production-releases.md).
 */
export async function compactReaderRenewals(pool: Pool, lookback = '7 days', batch = 10_000) {
  return transaction(pool, async db => {
    // One pass at a time across processes; a busy pass is simply skipped.
    if (!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('arbor-reader-lease-compaction')) AS locked")).rows[0]!.locked)
      return 0;
    const result = await db.query(`WITH ended AS (
        SELECT id,reader_id,user_id,card_id,uid_hash,target_kind,target_id,reason,created_at,expires_at
        FROM app_device_access_event
        WHERE allowed AND NOT is_tap AND expires_at>created_at
          AND expires_at>=NOW()-$1::interval AND expires_at<NOW()-INTERVAL '10 minutes'
        ORDER BY expires_at,id LIMIT $2
      ), reach AS (
        SELECT *,max(expires_at) OVER (lease ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS reached
        FROM ended WINDOW lease AS (PARTITION BY reader_id,user_id,card_id,uid_hash,target_kind,target_id,reason ORDER BY created_at,id)
      ), runs AS (
        SELECT *,count(*) FILTER (WHERE reached IS NULL OR created_at>reached) OVER lease AS run
        FROM reach WINDOW lease AS (PARTITION BY reader_id,user_id,card_id,uid_hash,target_kind,target_id,reason ORDER BY created_at,id)
      ), placed AS (
        SELECT id,first_value(id) OVER span AS first_id,row_number() OVER span AS position,
          count(*) OVER (PARTITION BY reader_id,user_id,card_id,uid_hash,target_kind,target_id,reason,run) AS size
        FROM runs WINDOW span AS (PARTITION BY reader_id,user_id,card_id,uid_hash,target_kind,target_id,reason,run ORDER BY created_at,id)
      ), removed AS (
        DELETE FROM app_device_access_event e USING placed p
        WHERE e.id=p.id AND p.position>1 AND p.position<p.size
        RETURNING p.first_id,e.expires_at
      ), stretched AS (
        UPDATE app_device_access_event e SET expires_at=r.reach
        FROM (SELECT first_id,max(expires_at) AS reach FROM removed GROUP BY first_id) r
        WHERE e.id=r.first_id AND r.reach>e.expires_at
      ) SELECT count(*)::int AS removed FROM removed`, [lookback, batch]);
    return result.rows[0]!.removed as number;
  });
}

export function startReaderLeaseCompaction(pool: Pool, intervalMs = READER_LEASE_COMPACTION_INTERVAL_MS) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = compactReaderRenewals(pool).then(() => {}).catch((error: unknown) => {
      console.error('Reader lease compaction failed; retrying on the next interval', errorIdentifier(error));
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
