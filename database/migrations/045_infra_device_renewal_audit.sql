-- A machine reader renews a member's lease about once a second while the card
-- stays on it, and each renewal is stored as an app_device_access_event row
-- (is_tap=false). The row trigger from 016_comprehensive_audit copied every one
-- into the append-only app_staff_audit, which can never be pruned, and the change
-- log listed them as card taps. Keep auditing physical taps and refused renewals
-- (the moment access ends), including any later edit or delete of them. Granted
-- renewals are never audited, so the background compaction that collapses each
-- ended run of them (readerLeaseCompaction.ts) adds nothing to the audit log.
-- That compaction runs as the application, so its database role needs UPDATE
-- and DELETE on app_device_access_event.
DROP TRIGGER IF EXISTS app_capture_change ON app_device_access_event;
CREATE TRIGGER app_capture_change AFTER INSERT ON app_device_access_event
  FOR EACH ROW WHEN (NEW.is_tap OR NOT NEW.allowed) EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_capture_change_update AFTER UPDATE ON app_device_access_event
  FOR EACH ROW WHEN (OLD.is_tap OR NOT OLD.allowed OR NEW.is_tap OR NOT NEW.allowed)
  EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_capture_change_delete AFTER DELETE ON app_device_access_event
  FOR EACH ROW WHEN (OLD.is_tap OR NOT OLD.allowed) EXECUTE FUNCTION app_capture_change('id');
-- Live-lease lookups (staff reports and the equipment list) ask for every
-- unexpired grant without a machine id, which app_equipment_live_grants cannot
-- serve; the compaction also walks recently ended grants by expiry.
CREATE INDEX IF NOT EXISTS app_device_event_live_leases
  ON app_device_access_event(expires_at) WHERE allowed;
