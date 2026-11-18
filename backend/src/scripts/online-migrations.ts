// Companion steps for the numbered migrations listed below. Run on the owner
// connection after committing their reviewed SQL and recording its checksums.
import type { Database } from '../db.js';

// pg_get_indexdef normalizes the catalog definition to this format. Use the
// same definition to build the index and confirm what a retry will reuse.
const setupIndex = {
  name: 'app_reader_setup_one_in_progress_device',
  table: 'app_reader_setup_job',
  definition: "CREATE UNIQUE INDEX app_reader_setup_one_in_progress_device ON app_reader_setup_job USING btree (gateway_id, device_id) WHERE (status <> ALL (ARRAY['complete'::text, 'failed'::text, 'cancelled'::text, 'expired'::text]))",
};
const leaseIndex = {
  name: 'app_device_event_live_leases',
  table: 'app_device_access_event',
  definition: 'CREATE INDEX app_device_event_live_leases ON app_device_access_event USING btree (expires_at) WHERE (allowed AND (expires_at IS NOT NULL))',
};
const refundIndex = {
  name: 'app_equipment_checkout_refund_id_key',
  table: 'app_equipment_checkout',
  definition: 'CREATE UNIQUE INDEX app_equipment_checkout_refund_id_key ON app_equipment_checkout USING btree (refund_id) WHERE (refund_id IS NOT NULL)',
};

const checkoutRefundBackfills = [
  {
    name: 'app_pass_checkout_refund_due',
    table: 'app_pass_checkout',
    key: 'id',
    definition: 'CREATE INDEX app_pass_checkout_refund_due ON app_pass_checkout USING btree (refund_reconcile_after) WHERE (refund_reconcile_after IS NOT NULL)',
    eligible: 'pass_id IS NULL AND cancel_requested_at IS NOT NULL',
  },
  {
    name: 'app_equipment_checkout_refund_due',
    table: 'app_equipment_checkout',
    key: 'reservation_id',
    definition: 'CREATE INDEX app_equipment_checkout_refund_due ON app_equipment_checkout USING btree (refund_reconcile_after) WHERE (refund_reconcile_after IS NOT NULL)',
    // Old paid equipment checkouts did not distinguish a failed lookup from an empty one.
    eligible: 'TRUE',
  },
];
const uncheckedEquipmentRefunds = {
  name: 'app_equipment_checkout_refund_unchecked',
  table: 'app_equipment_checkout',
  definition: "CREATE INDEX app_equipment_checkout_refund_unchecked ON app_equipment_checkout USING btree (reservation_id) WHERE ((status = 'paid'::text) AND (payment_id IS NOT NULL) AND (payment_intent IS NOT NULL) AND (refund_id IS NULL) AND (refund_reconcile_after IS NULL) AND (refund_checked_at IS NULL))",
};
const checkoutRefundMigration = '053_checkout_refund_reconciliation.sql';
const checkoutRefundBackfill = `online:${checkoutRefundMigration}`;

async function checkoutRefundBackfillDone(db: Database) {
  const result = await db.query(`SELECT 1 FROM public.app_migration online
    JOIN public.app_migration numbered USING (checksum)
    WHERE online.name=$1 AND numbered.name=$2`, [checkoutRefundBackfill, checkoutRefundMigration]);
  return !!result.rowCount;
}

async function queueLegacyCheckoutRefunds(db: Database) {
  if (await checkoutRefundBackfillDone(db)) return;
  for (const { table, key, eligible } of checkoutRefundBackfills) {
    // Walk the primary key a bounded page at a time. Each page commits independently.
    // Recheck eligibility on UPDATE so a concurrent write cannot enqueue a refunded checkout.
    let lastKey: string | null = null;
    for (;;) {
      const { rows }: { rows: { last_key: string | null }[] } = await db.query(`WITH batch AS (
        SELECT ${key} FROM public.${table}
        ${lastKey === null ? '' : `WHERE ${key} > $1`} ORDER BY ${key} LIMIT 500
      ), queued AS (
        UPDATE public.${table} SET refund_reconcile_after=now()
        WHERE ${key} IN (SELECT ${key} FROM batch)
          AND status='paid' AND payment_id IS NOT NULL AND payment_intent IS NOT NULL
          AND refund_id IS NULL AND refund_reconcile_after IS NULL AND ${eligible}
      )
      SELECT (SELECT ${key}::text FROM batch ORDER BY ${key} DESC LIMIT 1) AS last_key`,
      lastKey === null ? [] : [lastKey]);
      lastKey = rows[0]!.last_key;
      if (lastKey === null) break;
    }
  }
  // Distinguish finished backfill from a later worker successfully clearing the queue.
  await db.query(`INSERT INTO public.app_migration(name,checksum)
    SELECT $1,checksum FROM public.app_migration WHERE name=$2`, [checkoutRefundBackfill, checkoutRefundMigration]);
}

const oldSetupIndex = 'app_reader_setup_one_active_device';
const refundGuard = 'app_equipment_checkout_refund_online_pending';
const checkInOrigin = 'app_check_in_origin';

async function indexValid(db: Database, index: typeof setupIndex) {
  const { rows: [state] } = await db.query<{ valid: boolean; matches: boolean }>(
    `SELECT indisvalid AND indisready AS valid,
      indrelid = to_regclass($2) AND replace(pg_get_indexdef(indexrelid), ' ON public.', ' ON ') = $3 AS matches
      FROM pg_index WHERE indexrelid=to_regclass($1)`,
    [`public.${index.name}`, `public.${index.table}`, index.definition],
  );
  if (state && !state.matches)
    throw new Error(`Unexpected migration index definition: ${index.name}`);
  return state?.valid;
}

async function ensureIndex(db: Database, index: typeof setupIndex) {
  const valid = await indexValid(db, index);
  if (valid) return;
  // A cancelled build can leave an invalid index. IF NOT EXISTS would skip it.
  if (valid === false) await db.query(`DROP INDEX CONCURRENTLY public.${index.name}`);
  await db.query(index.definition.replace('INDEX ', 'INDEX CONCURRENTLY ').replace(' ON ', ' ON public.'));
}

async function oldSetupIndexExists(db: Database) {
  const { rows: [state] } = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present', [`public.${oldSetupIndex}`],
  );
  return state!.present;
}

const hasSentLink = "status NOT IN ('pending','sending') AND (payload ? 'resetUrl' OR payload ? 'confirmationUrl')";

async function clearPreviouslySentLinks(db: Database) {
  // The trigger already covers new rows and transitions out of pending/sending.
  const { rows: [end] } = await db.query<{ id: string | null }>(
    'SELECT max(id)::text AS id FROM public.app_notification_outbox',
  );
  if (end!.id === null) return;
  let lastId: string | null = null;
  for (;;) {
    // A separate lower-bound predicate lets generic plans seek into the primary key.
    const result: { rows: { last_id: string | null }[] } = await db.query(`WITH batch AS (
      SELECT id FROM public.app_notification_outbox
      WHERE id <= $1 ${lastId === null ? '' : 'AND id > $2'} ORDER BY id LIMIT 500
    ), scrubbed AS (
      UPDATE public.app_notification_outbox
      SET payload = payload - 'resetUrl' - 'confirmationUrl'
      WHERE id IN (SELECT id FROM batch) AND ${hasSentLink}
    )
    SELECT max(id)::text AS last_id FROM batch`, lastId === null ? [end!.id] : [end!.id, lastId]);
    lastId = result.rows[0]!.last_id;
    if (lastId === null || lastId === end!.id) return;
  }
}

async function constraintValidated(db: Database, table: string, constraint: string) {
  const { rows: [state] } = await db.query<{ convalidated: boolean }>(
    'SELECT convalidated FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$2',
    [`public.${table}`, constraint],
  );
  return state?.convalidated;
}

export async function finishOnlineMigrations(db: Database) {
  // 045_reader_setup_again.sql: the old index covers a superset of these rows.
  await ensureIndex(db, setupIndex);
  if (await oldSetupIndexExists(db))
    await db.query(`DROP INDEX CONCURRENTLY public.${oldSetupIndex}`);

  // 048_device_renewal_audit.sql: support lease lookups and compaction by expiry.
  await ensureIndex(db, leaseIndex);

  // 049_equipment_refund_retry.sql: keep non-null refund IDs gated until unique.
  await ensureIndex(db, refundIndex);

  // 053_checkout_refund_reconciliation.sql: build both due indexes without blocking writes.
  for (const index of [...checkoutRefundBackfills, uncheckedEquipmentRefunds]) await ensureIndex(db, index);

  // 051_desk_check_in_origin.sql: new rows already obey the NOT VALID check.
  if (!(await constraintValidated(db, 'check_in', checkInOrigin)))
    await db.query(`ALTER TABLE public.check_in VALIDATE CONSTRAINT ${checkInOrigin}`);

  await db.query("SET lock_timeout = '250ms'");
  if ((await constraintValidated(db, refundIndex.table, refundGuard)) !== undefined)
    await db.query(`ALTER TABLE public.app_equipment_checkout DROP CONSTRAINT ${refundGuard}`);

  // 046_forget_sent_links.sql: scrub existing terminal rows in committed batches.
  await clearPreviouslySentLinks(db);
  await queueLegacyCheckoutRefunds(db);
}

export async function verifyOnlineMigrations(db: Database) {
  const finish = 'Complete the reviewed online migration phase.';
  for (const index of [setupIndex, leaseIndex, refundIndex, ...checkoutRefundBackfills, uncheckedEquipmentRefunds]) {
    if (!(await indexValid(db, index)))
      throw new Error(`Migration index is missing or invalid: ${index.name}. ${finish}`);
  }
  if (!(await checkoutRefundBackfillDone(db)))
    throw new Error(`Migration checkout refund backfill is incomplete. ${finish}`);
  if (await oldSetupIndexExists(db))
    throw new Error(`Migration index ${oldSetupIndex} still needs removal. ${finish}`);
  if ((await constraintValidated(db, refundIndex.table, refundGuard)) !== undefined)
    throw new Error(`Migration constraint ${refundGuard} still needs removal. ${finish}`);
  if (!(await constraintValidated(db, 'check_in', checkInOrigin)))
    throw new Error(`Migration constraint ${checkInOrigin} still needs validation. ${finish}`);
  if ((await db.query(`SELECT 1 FROM public.app_notification_outbox WHERE ${hasSentLink} LIMIT 1`)).rowCount)
    throw new Error(`Migration cleanup of previously sent links is incomplete. ${finish}`);
}
