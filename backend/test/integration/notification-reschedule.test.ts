import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { enqueueNotification, updateNotificationPreferences } from '../../src/notifications/store.js';
import { reminderDates } from '../../src/notifications/scheduler.js';
import { reminderTimingCases } from '../notification-timing-cases.js';

const database = 'arbor_' + randomBytes(6).toString('hex') + '_notification_reschedule_mvc_test';
const admin = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
let created = false; let userId: number;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Use explicit isolated PostgreSQL settings');
  await admin.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  userId = (await pool.query(`SELECT userid FROM "user" WHERE status='active' ORDER BY userid LIMIT 1`)).rows[0].userid;
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });

/** Queues a reminder the way the scheduler does, for a member in another zone. */
async function queueReminder(key: string, expiresAt: string, status = 'pending', attempts = 0) {
  const expiry = new Date(expiresAt);
  await enqueueNotification(pool, { userId, kind: 'waiver_expiring', dedupeKey: key, ...reminderDates(expiry, 'Pacific/Honolulu'),
    payload: { sourceType: 'waiver', sourceId: 1, expiresAt: expiry.toISOString(), name: 'Shop safety' } });
  await pool.query('UPDATE app_notification_outbox SET status=$2,attempts=$3 WHERE dedupe_key=$1', [key, status, attempts]);
}
const row = async (key: string) =>
  (await pool.query('SELECT due_at,deadline_at FROM app_notification_outbox WHERE dedupe_key=$1', [key])).rows[0];

test('a time zone change reschedules unsent reminders to the same time as first queueing', async () => {
  for (const c of reminderTimingCases) {
    await pool.query('DELETE FROM app_notification_outbox');
    await updateNotificationPreferences(pool, userId, { enabled: true, timeZone: 'Pacific/Honolulu' });
    await queueReminder('reminder', c.expiresAt);
    const before = await row('reminder');
    await updateNotificationPreferences(pool, userId, { enabled: true, timeZone: c.timeZone });
    const after = await row('reminder');
    assert.equal(after.due_at.toISOString(), c.dueAt, c.name);
    assert.equal(after.due_at.toISOString(), reminderDates(new Date(c.expiresAt), c.timeZone).dueAt.toISOString(), c.name);
    assert.equal(after.deadline_at.getTime(), before.deadline_at.getTime(), c.name);
  }
});

test('only unattempted pending reminders move', async () => {
  await pool.query('DELETE FROM app_notification_outbox');
  await updateNotificationPreferences(pool, userId, { enabled: true, timeZone: 'Pacific/Honolulu' });
  const expiresAt = reminderTimingCases[0]!.expiresAt;
  await queueReminder('attempted', expiresAt, 'pending', 1);
  await queueReminder('sending', expiresAt, 'sending', 1);
  await queueReminder('accepted', expiresAt, 'accepted', 1);
  await enqueueNotification(pool, { userId, kind: 'account_created', dedupeKey: 'event', payload: {} });
  const before = (await pool.query('SELECT dedupe_key,due_at FROM app_notification_outbox ORDER BY dedupe_key')).rows;
  await updateNotificationPreferences(pool, userId, { enabled: true, timeZone: 'Asia/Tokyo' });
  assert.deepEqual((await pool.query('SELECT dedupe_key,due_at FROM app_notification_outbox ORDER BY dedupe_key')).rows, before);
});
