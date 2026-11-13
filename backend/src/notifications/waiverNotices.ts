import type { Database } from '../db.js';
import { EXPIRATION_LOOKAHEAD_DAYS, reminderDates } from './scheduler.js';
import { enqueueNotification, getNotificationPreferences } from './store.js';

/** Waiver-signing notices. The caller's transaction records the signature. */
export async function queueWaiverSigned(db: Database, userId: number, signatureId: number, payload: Record<string, unknown>) {
  await enqueueNotification(db, {
    userId,
    kind: 'waiver_signed',
    dedupeKey: `waiver-signed:${signatureId}`,
    payload,
  });
}

/**
 * Keep the scheduler's existing horizon. Short-lived signatures can expire before
 * its next daily scan, so queue those reminders when signing.
 */
export async function queueEarlyExpiryReminder(db: Database, userId: number, waiverName: string,
  signatureId: number, signedAt: Date, expiresAt: Date | null) {
  if (!expiresAt || !(new Date(expiresAt).getTime() <= Date.now() + EXPIRATION_LOOKAHEAD_DAYS * 86_400_000)) return;
  const prefs = await getNotificationPreferences(db, userId);
  const expiry = new Date(expiresAt), dates = reminderDates(expiry, prefs.timeZone);
  await enqueueNotification(db, {
    userId,
    kind: 'waiver_expiring',
    dedupeKey: `waiver-expiring:${signatureId}:${expiry.toISOString()}`,
    ...dates,
    countsForSla: new Date(signedAt) < dates.deadlineAt,
    payload: { sourceType: 'waiver', sourceId: signatureId, expiresAt: expiry.toISOString(), name: waiverName },
  });
}
