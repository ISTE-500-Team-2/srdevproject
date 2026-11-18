import type { Pool } from 'pg';

/** Claim SELECT copied from c95a2b5, including its joins, ordering and row lock. */
export async function previousNotificationCandidate(pool: Pool, now: Date) {
  const { rows } = await pool.query<{ kind: string }>(`SELECT o.id,o.userid AS "userId",o.registration_id AS "registrationId",o.kind,o.dedupe_key AS "dedupeKey",o.payload,
        o.attempts,o.due_at AS "dueAt",o.deadline_at AS "deadlineAt",
        -- Email-change notices go where they were addressed: the new inbox, or the one in use when asked.
        COALESCE(CASE WHEN o.kind IN ('email_change_confirmation','email_change_requested') THEN o.payload->>'recipientEmail' END,u.email,r.email) AS email,
        COALESCE(u.firstname,r.first_name) AS "firstName",
        COALESCE(p.time_zone,r.time_zone,'America/New_York') AS "timeZone"
        FROM app_notification_outbox o LEFT JOIN "user" u ON u.userid=o.userid
        LEFT JOIN app_pending_registration r ON r.id=o.registration_id
        LEFT JOIN app_notification_preferences p ON p.userid=o.userid
        WHERE o.status='pending' AND o.due_at<=$1 ORDER BY o.due_at,o.id
        LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, [now]);
  return rows[0]?.kind;
}
