-- A non-null deadline marks refund work that must survive checkout webhook delivery.
ALTER TABLE app_pass_checkout ADD COLUMN refund_reconcile_after TIMESTAMPTZ;
ALTER TABLE app_equipment_checkout ADD COLUMN refund_reconcile_after TIMESTAMPTZ;

-- Recover unissued payments recorded before the sweep was added.
UPDATE app_pass_checkout SET refund_reconcile_after=now()
 WHERE status='paid' AND pass_id IS NULL AND payment_id IS NOT NULL AND payment_intent IS NOT NULL
   AND cancel_requested_at IS NOT NULL AND refund_id IS NULL;

-- Existing paid equipment checkouts have no marker to distinguish a failed lookup from an empty one.
-- Queue one lookup for those without a recorded refund. The worker processes them in bounded batches.
UPDATE app_equipment_checkout SET refund_reconcile_after=now()
 WHERE status='paid' AND payment_id IS NOT NULL AND payment_intent IS NOT NULL AND refund_id IS NULL;

CREATE INDEX app_pass_checkout_refund_due ON app_pass_checkout(refund_reconcile_after)
 WHERE refund_reconcile_after IS NOT NULL;
CREATE INDEX app_equipment_checkout_refund_due ON app_equipment_checkout(refund_reconcile_after)
 WHERE refund_reconcile_after IS NOT NULL;
