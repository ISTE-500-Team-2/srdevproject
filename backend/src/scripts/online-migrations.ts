// Migration 045 needs its replacement index before dropping the old one. The
// other scans wait until the numbered migrations release their DDL locks.
import type { Database } from '../db.js';

export const setupMigration = '045_reader_setup_again.sql';
const setupIndex = 'app_reader_setup_one_in_progress_device';
const leaseIndex = 'app_device_event_live_leases';
const refundIndex = 'app_equipment_checkout_refund_id_key';

async function indexValid(db: Database, name: string) {
  const { rows } = await db.query<{ valid: boolean }>(
    'SELECT indisvalid AND indisready AS valid FROM pg_index WHERE indexrelid=to_regclass($1)',
    [`public.${name}`],
  );
  return rows[0]?.valid;
}

async function ensureIndex(db: Database, name: string, definition: string, unique = false) {
  const valid = await indexValid(db, name);
  if (valid) return;
  // A cancelled build can leave an invalid index. IF NOT EXISTS would skip it.
  if (valid === false) await db.query(`DROP INDEX CONCURRENTLY public.${name}`);
  await db.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${name} ON ${definition}`);
}

export async function prepareReaderSetupIndex(db: Database) {
  const { rows } = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.app_reader_setup_job') IS NOT NULL AS present",
  );
  if (!rows[0]!.present) return;
  // The old index enforces uniqueness over a superset of these rows until 045 commits.
  await ensureIndex(db, setupIndex, `public.app_reader_setup_job(gateway_id,device_id)
    WHERE status NOT IN ('complete','failed','cancelled','expired')`, true);
}

const hasSentLink = "status NOT IN ('pending','sending') AND (payload ? 'resetUrl' OR payload ? 'confirmationUrl')";

async function clearPreviouslySentLinks(db: Database) {
  // The trigger already covers new rows and transitions out of pending/sending.
  const { rows: [end] } = await db.query<{ id: string | null }>(
    'SELECT max(id)::text AS id FROM app_notification_outbox',
  );
  if (end!.id === null) return;
  let lastId: string | null = null;
  for (;;) {
    // Each batch scans a bounded range of primary keys and commits separately.
    const result: { rows: { last_id: string | null }[] } = await db.query(`WITH batch AS (
      SELECT id FROM app_notification_outbox
      WHERE ($1::bigint IS NULL OR id > $1) AND id <= $2 ORDER BY id LIMIT 500
    ), scrubbed AS (
      UPDATE app_notification_outbox
      SET payload = payload - 'resetUrl' - 'confirmationUrl'
      WHERE id IN (SELECT id FROM batch) AND ${hasSentLink}
    )
    SELECT max(id)::text AS last_id FROM batch`, [lastId, end!.id]);
    lastId = result.rows[0]!.last_id;
    if (lastId === null || lastId === end!.id) return;
  }
}

async function checkInOriginValidated(db: Database) {
  const { rows } = await db.query<{ convalidated: boolean }>(
    "SELECT convalidated FROM pg_constraint WHERE conrelid='public.check_in'::regclass AND conname='app_check_in_origin'",
  );
  return rows[0]?.convalidated;
}

export async function finishOnlineMigrations(db: Database) {
  await ensureIndex(db, leaseIndex,
    'public.app_device_access_event(expires_at) WHERE allowed AND expires_at IS NOT NULL');
  await ensureIndex(db, refundIndex,
    'public.app_equipment_checkout(refund_id) WHERE refund_id IS NOT NULL', true);
  if (!(await checkInOriginValidated(db)))
    await db.query('ALTER TABLE public.check_in VALIDATE CONSTRAINT app_check_in_origin');
  await db.query("SET lock_timeout = '250ms'");
  await clearPreviouslySentLinks(db);
}

export async function verifyOnlineMigrations(db: Database) {
  for (const index of [setupIndex, leaseIndex, refundIndex]) {
    if (!(await indexValid(db, index)))
      throw new Error(`Migration index is missing or invalid: ${index}. Run the owner migration runner.`);
  }
  if (!(await checkInOriginValidated(db)))
    throw new Error('Migration constraint app_check_in_origin still needs validation. Run the owner migration runner.');
  if ((await db.query(`SELECT 1 FROM app_notification_outbox WHERE ${hasSentLink} LIMIT 1`)).rowCount)
    throw new Error('Migration cleanup of previously sent links is incomplete. Run the owner migration runner.');
}
