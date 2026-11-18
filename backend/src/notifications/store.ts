// Transactional email outbox, preferences and delivery metrics. Dedupe keys prevent repeated domain
// events from queuing duplicate notices.

import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { reminderDates, validTimeZone } from './reminderTiming.js';
import { securityKinds, type NotificationKind, type NotificationPayloads } from './templates.js';

export interface NotificationPreferences { enabled: boolean; timeZone: string }
/** A known kind's payload is typed by that kind. A kind only known at run time
 * (a plain string) takes any payload; the worker checks it before rendering. */
export interface NotificationInput<K extends string = NotificationKind> {
  userId: number; kind: K; dedupeKey: string; dueAt?: Date; deadlineAt?: Date; countsForSla?: boolean;
  payload: K extends NotificationKind ? NotificationPayloads[K] : Record<string, unknown>;
}
/** Literal kinds must be known kinds, so a misspelt kind does not compile. */
type CheckedKind<K extends string> = string extends K ? K : K extends NotificationKind ? K : never;
export { validTimeZone };
export async function getNotificationPreferences(db: Database, userId: number): Promise<NotificationPreferences> {
  const { rows } = await db.query<NotificationPreferences>(`SELECT COALESCE(p.enabled,true) AS enabled,
    COALESCE(p.time_zone,'America/New_York') AS "timeZone" FROM "user" u
    LEFT JOIN app_notification_preferences p USING(userid) WHERE u.userid=$1`, [userId]);
  if (!rows[0]) throw new AppError(404,'NOT_FOUND','Account not found.');
  return rows[0];
}
export async function updateNotificationPreferences(db: Database, userId: number, preferences: NotificationPreferences): Promise<NotificationPreferences> {
  if (typeof preferences.enabled !== 'boolean' || !validTimeZone(preferences.timeZone))
    throw new AppError(400,'INVALID_NOTIFICATION_PREFERENCES','Choose a valid time zone and notification preference.');
  await db.query(`INSERT INTO app_notification_preferences(userid,enabled,time_zone) VALUES($1,$2,$3)
    ON CONFLICT(userid) DO UPDATE SET enabled=EXCLUDED.enabled,time_zone=EXCLUDED.time_zone,updated_at=NOW()`,
    [userId,preferences.enabled,preferences.timeZone]);
  // Opting back in never resurrects notices that were intentionally suppressed.
  if (!preferences.enabled) await db.query(`UPDATE app_notification_outbox SET status='suppressed',counts_for_sla=(counts_for_sla AND deadline_at<NOW()),updated_at=NOW()
    WHERE userid=$1 AND status='pending' AND kind <> ALL($2::text[])`,[userId,securityKinds]);
  // Unsent expiration reminders move to the new zone's send time, computed exactly as when first queued.
  if (preferences.enabled) {
    const { rows } = await db.query<{ id: number; expiresAt: string }>(`SELECT id,payload->>'expiresAt' AS "expiresAt" FROM app_notification_outbox
      WHERE userid=$1 AND status='pending' AND attempts=0 AND payload ? 'sourceType' AND payload ? 'expiresAt' ORDER BY id FOR UPDATE`,[userId]);
    for (const row of rows)
      await db.query(`UPDATE app_notification_outbox SET due_at=$2,updated_at=NOW() WHERE id=$1 AND status='pending' AND attempts=0`,
        [row.id,reminderDates(new Date(row.expiresAt),preferences.timeZone).dueAt]);
  }
  return preferences;
}
export async function enqueueNotification<K extends string>(db: Database, input: NotificationInput<K> & { kind: CheckedKind<K> }): Promise<void> {
  if (!input.kind || !input.dedupeKey) throw new Error('Notification kind and dedupe key are required');
  await insertOutbox(db, input.userId, input.dedupeKey, input);
}
/** Queues one notice for many accounts in a single statement, not one round trip each.
 * Each account's dedupe key is the prefix followed by its user ID. */
export async function enqueueNotifications<K extends string>(db: Database, userIds: number[],
  input: Omit<NotificationInput<K>, 'userId' | 'dedupeKey'> & { kind: CheckedKind<K>; dedupePrefix: string }): Promise<void> {
  if (!input.kind || !input.dedupePrefix) throw new Error('Notification kind and dedupe key are required');
  if (userIds.length) await insertOutbox(db, userIds, input.dedupePrefix, input);
}
/** For a list of accounts, the dedupe key is a prefix completed with each user ID. */
async function insertOutbox(db: Database, recipients: number | number[], dedupeKey: string,
  input: { kind: string; payload: unknown; dueAt?: Date; deadlineAt?: Date; countsForSla?: boolean }) {
  const many = Array.isArray(recipients);
  const dueAt = input.dueAt ?? new Date();
  // Event notices have a measurable five-minute dispatch target, not a promised delivery SLA.
  const deadlineAt = input.deadlineAt ?? new Date(dueAt.getTime()+5*60_000);
  if (!Number.isFinite(dueAt.getTime()) || !Number.isFinite(deadlineAt.getTime())) throw new Error('Invalid notification date');
  // Legacy unverified accounts may still receive their confirmation or password-reset link while held in pending status,
  // and the notice that someone tried to sign up with their address (which points them to sign-in or a reset).
  await db.query(`INSERT INTO app_notification_outbox(userid,kind,dedupe_key,payload,due_at,deadline_at,status,counts_for_sla)
    SELECT u.userid,$2,${many ? '$3::text||u.userid' : '$3'},$4::jsonb,$5,$6,
      CASE WHEN (COALESCE(p.enabled,true) OR $2=ANY($8::text[])) AND (u.status='active' OR ($2 IN ('account_confirmation','password_reset','account_exists') AND u.status='pending')) THEN 'pending' ELSE 'suppressed' END,
      $7::boolean AND (COALESCE(p.enabled,true) OR $2=ANY($8::text[])) AND (u.status='active' OR ($2 IN ('account_confirmation','password_reset','account_exists') AND u.status='pending'))
    FROM "user" u LEFT JOIN app_notification_preferences p USING(userid) WHERE ${many ? 'u.userid=ANY($1::int[])' : 'u.userid=$1'}
    ON CONFLICT(dedupe_key) DO UPDATE SET due_at=COALESCE(EXCLUDED.worker_v2_due_at,EXCLUDED.due_at),deadline_at=EXCLUDED.deadline_at,updated_at=NOW()
    WHERE app_notification_outbox.status='pending' AND app_notification_outbox.attempts=0
      AND EXCLUDED.payload ? 'sourceType'`,[recipients,input.kind,dedupeKey,JSON.stringify(input.payload),dueAt,deadlineAt,input.countsForSla??true,securityKinds]);
}
export async function notificationMetrics(
  db: Database,
  window?: { from: Date; to: Date },
) {
  const { rows } = await db.query(
    `SELECT o.kind,
    COUNT(*) FILTER (WHERE deadline_at<=NOW() AND counts_for_sla=true)::int AS eligible,
    COUNT(*) FILTER (WHERE deadline_at<=NOW() AND counts_for_sla=true AND status='accepted' AND accepted_at<=deadline_at)::int AS on_time,
    COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
    COUNT(*) FILTER (WHERE status='failed')::int AS failed,
    COUNT(*) FILTER (WHERE status='uncertain')::int AS uncertain,
    COUNT(*) FILTER (WHERE status='pending')::int AS pending,
    COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM app_notification_delivery_status e
      WHERE e.outbox_id=o.id AND e.event_type='delivered' AND e.occurred_at<=NOW()))::int AS delivered,
    COUNT(*) FILTER (WHERE deadline_at<=NOW() AND counts_for_sla=true AND EXISTS
      (SELECT 1 FROM app_notification_delivery_status e WHERE e.outbox_id=o.id AND e.event_type='delivered'
        AND e.occurred_at<=o.deadline_at))::int AS delivery_on_time,
    COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM app_notification_delivery_status e
      WHERE e.outbox_id=o.id AND e.event_type IN ('hard_bounce','blocked','invalid_email','error') AND e.occurred_at<=NOW()))::int AS delivery_failed
    FROM app_notification_outbox o WHERE ($1::timestamptz IS NULL OR deadline_at>=$1)
      AND ($2::timestamptz IS NULL OR deadline_at<$2) GROUP BY o.kind`,
    [window?.from ?? null, window?.to ?? null],
  );
  const totals = (items: typeof rows) => {
    const result = {
      eligible: 0,
      on_time: 0,
      accepted: 0,
      failed: 0,
      uncertain: 0,
      pending: 0,
      delivered: 0,
      delivery_on_time: 0,
      delivery_failed: 0,
    };
    for (const row of items)
      for (const key of Object.keys(result) as (keyof typeof result)[])
        result[key] += Number(row[key]);
    return {
      ...result,
      onTimePercent: result.eligible
        ? (100 * result.on_time) / result.eligible
        : null,
      deliveryOnTimePercent: result.eligible
        ? (100 * result.delivery_on_time) / result.eligible
        : null,
    };
  };
  const complianceKinds = new Set([
    "waiver_expiring",
    "certification_expiring",
  ]);
  return {
    ...totals(rows),
    metric: "provider acceptance by deadline; not inbox delivery",
    deliveryMetric:
      "provider delivered callbacks by deadline; not verified inbox placement",
    cohortWindow:
      "deadline date; only elapsed eligible deadlines enter percentage denominators",
    cohorts: {
      expirationCompliance: totals(
        rows.filter((row) => complianceKinds.has(row.kind)),
      ),
      membershipExpiration: totals(
        rows.filter((row) => row.kind === "membership_expiring"),
      ),
      other: totals(
        rows.filter(
          (row) =>
            !complianceKinds.has(row.kind) &&
            row.kind !== "membership_expiring",
        ),
      ),
    },
  };
}
