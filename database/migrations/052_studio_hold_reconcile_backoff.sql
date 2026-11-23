-- Background reconciliation of lapsed studio card holds (backend/src/studios/service.ts) backs off
-- a hold that keeps failing, so a few holds whose checkout can't be reached are not rechecked with
-- Stripe on every pass and can't take every slot of a batch. Existing rows start with no failures;
-- the previous release ignores both columns.
ALTER TABLE app_studio_rental ADD COLUMN IF NOT EXISTS reconcile_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_studio_rental ADD COLUMN IF NOT EXISTS reconcile_after TIMESTAMPTZ;

-- The failure count and next check time are bookkeeping for that background pass, not a change to
-- the booking, so an update that changes only them is not audited, as app_access_reader's
-- last_seen_at is not (027). Otherwise every failed pass, up to one an hour for as long as a hold
-- that can't be settled stays pending, would add a row to the append-only staff audit. The same
-- goes for the equipment checkout backoff from 049. Inserts, deletes and every other update are
-- still audited, under the same key as before.
DROP TRIGGER IF EXISTS app_capture_change ON app_studio_rental;
CREATE TRIGGER app_capture_change AFTER INSERT OR DELETE ON app_studio_rental
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_capture_row_change AFTER UPDATE ON app_studio_rental FOR EACH ROW
  WHEN ((to_jsonb(OLD)-'reconcile_failures'-'reconcile_after') IS DISTINCT FROM (to_jsonb(NEW)-'reconcile_failures'-'reconcile_after'))
  EXECUTE FUNCTION app_capture_change('id');
DROP TRIGGER IF EXISTS app_capture_change ON app_equipment_checkout;
CREATE TRIGGER app_capture_change AFTER INSERT OR DELETE ON app_equipment_checkout
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('reservation_id');
CREATE TRIGGER app_capture_row_change AFTER UPDATE ON app_equipment_checkout FOR EACH ROW
  WHEN ((to_jsonb(OLD)-'reconcile_failures'-'reconcile_after') IS DISTINCT FROM (to_jsonb(NEW)-'reconcile_failures'-'reconcile_after'))
  EXECUTE FUNCTION app_capture_change('reservation_id');
