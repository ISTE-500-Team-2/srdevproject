-- A non-null deadline marks refund work that must survive checkout webhook delivery.
-- Backfill and build the due indexes after commit in online-migrations.ts.
ALTER TABLE app_pass_checkout ADD COLUMN refund_reconcile_after TIMESTAMPTZ;
ALTER TABLE app_equipment_checkout ADD COLUMN refund_reconcile_after TIMESTAMPTZ;
-- NULL identifies legacy payments that still need a canonical refund lookup.
ALTER TABLE app_equipment_checkout ADD COLUMN refund_checked_at TIMESTAMPTZ;
-- Older app processes keep inserting rows with the original Stripe request shape.
ALTER TABLE app_pass_checkout ADD COLUMN checkout_has_expiry BOOLEAN NOT NULL DEFAULT false;
-- New requests pin their email and expiry. NULL preserves the request shape of older checkouts.
ALTER TABLE app_pass_checkout ADD COLUMN checkout_email TEXT,
  ADD COLUMN checkout_expires_at TIMESTAMPTZ,
  ADD COLUMN refund_needs_review BOOLEAN NOT NULL DEFAULT false;

-- A change to the next sweep time is bookkeeping, like the hold backoff in 052.
DROP TRIGGER app_capture_change ON app_pass_checkout;
CREATE TRIGGER app_capture_change AFTER INSERT OR DELETE ON app_pass_checkout
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_capture_row_change AFTER UPDATE ON app_pass_checkout FOR EACH ROW
  WHEN ((to_jsonb(OLD)-'refund_reconcile_after') IS DISTINCT FROM (to_jsonb(NEW)-'refund_reconcile_after'))
  EXECUTE FUNCTION app_capture_change('');

DROP TRIGGER app_capture_row_change ON app_equipment_checkout;
CREATE TRIGGER app_capture_row_change AFTER UPDATE ON app_equipment_checkout FOR EACH ROW
  WHEN ((to_jsonb(OLD)-'reconcile_failures'-'reconcile_after'-'refund_reconcile_after'-'refund_checked_at') IS DISTINCT FROM
        (to_jsonb(NEW)-'reconcile_failures'-'reconcile_after'-'refund_reconcile_after'-'refund_checked_at'))
  EXECUTE FUNCTION app_capture_change('reservation_id');
