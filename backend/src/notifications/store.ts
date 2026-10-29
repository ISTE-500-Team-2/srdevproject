import type { Database } from '../db.js';
import { AppError } from '../domain.js';

export interface NotificationPreferences { enabled: boolean; timeZone: string }
export interface NotificationInput {
  userId: number; kind: string; dedupeKey: string; dueAt?: Date; deadlineAt?: Date;
  payload: Record<string, unknown>;
}
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}
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
    WHERE userid=$1 AND status='pending' AND kind NOT IN ('password_reset','password_changed')`,[userId]);
  if (preferences.enabled) await db.query(`UPDATE app_notification_outbox SET due_at=LEAST(
    (((payload->>'expiresAt')::timestamptz AT TIME ZONE $2)::date-8+TIME '09:00') AT TIME ZONE $2,
    deadline_at-INTERVAL '1 hour'),updated_at=NOW()
    WHERE userid=$1 AND status='pending' AND attempts=0 AND payload ? 'sourceType' AND payload ? 'expiresAt'`,[userId,preferences.timeZone]);
  return preferences;
}
export async function enqueueNotification(db: Database, input: NotificationInput): Promise<void> {
  if (!input.kind || !input.dedupeKey) throw new Error('Notification kind and dedupe key are required');
  const dueAt = input.dueAt ?? new Date();
  // Event notices have a measurable five-minute dispatch target, not a promised delivery SLA.
  const deadlineAt = input.deadlineAt ?? new Date(dueAt.getTime()+5*60_000);
  if (!Number.isFinite(dueAt.getTime()) || !Number.isFinite(deadlineAt.getTime())) throw new Error('Invalid notification date');
  // Legacy unverified accounts may still receive their confirmation link while held in pending status.
  await db.query(`INSERT INTO app_notification_outbox(userid,kind,dedupe_key,payload,due_at,deadline_at,status,counts_for_sla)
    SELECT u.userid,$2,$3,$4::jsonb,$5,$6,
      CASE WHEN (COALESCE(p.enabled,true) OR $2 IN ('password_reset','password_changed')) AND (u.status='active' OR ($2='account_confirmation' AND u.status='pending')) THEN 'pending' ELSE 'suppressed' END,
      (COALESCE(p.enabled,true) OR $2 IN ('password_reset','password_changed')) AND (u.status='active' OR ($2='account_confirmation' AND u.status='pending'))
    FROM "user" u LEFT JOIN app_notification_preferences p USING(userid) WHERE u.userid=$1
    ON CONFLICT(dedupe_key) DO UPDATE SET due_at=EXCLUDED.due_at,deadline_at=EXCLUDED.deadline_at,updated_at=NOW()
    WHERE app_notification_outbox.status='pending' AND app_notification_outbox.attempts=0
      AND EXCLUDED.payload ? 'sourceType'`,[input.userId,input.kind,input.dedupeKey,JSON.stringify(input.payload),dueAt,deadlineAt]);
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
export async function recordDeliveryEvent(db: Database, input: {eventKey:string; messageId:string; type:string; occurredAt:Date}): Promise<void> {
  await db.query(`INSERT INTO app_notification_delivery_event(event_key,outbox_id,event_type,occurred_at)
    SELECT $1,id,$3,$4 FROM app_notification_outbox WHERE provider_message_id=$2
    ON CONFLICT(event_key) DO NOTHING`,[input.eventKey,input.messageId,input.type,input.occurredAt]);
}
