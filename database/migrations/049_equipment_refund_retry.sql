-- Card-paid equipment bookings can be refunded: staff refund them from Payments, and refunds
-- made in Stripe arrive by webhook (backend/src/billing/equipment.ts). As for day passes, the
-- latest Stripe refund and its status are kept so repeated or out-of-order events apply once.
-- Existing releases leave refund_id null. Gate writes to the new column until
-- the online phase in backend/src/scripts/online-migrations.ts builds its unique index.
ALTER TABLE app_equipment_checkout ADD COLUMN IF NOT EXISTS refund_id TEXT;
ALTER TABLE app_equipment_checkout ADD CONSTRAINT app_equipment_checkout_refund_online_pending
  CHECK (refund_id IS NULL) NOT VALID;
ALTER TABLE app_equipment_checkout ADD COLUMN IF NOT EXISTS refund_status TEXT;
-- Background reconciliation backs off a pending checkout that keeps failing, so a few stuck
-- checkouts are not rechecked with Stripe on every pass and can't take every slot of a batch.
-- Existing rows start with no failures; the previous release ignores both columns.
ALTER TABLE app_equipment_checkout ADD COLUMN IF NOT EXISTS reconcile_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_equipment_checkout ADD COLUMN IF NOT EXISTS reconcile_after TIMESTAMPTZ;
