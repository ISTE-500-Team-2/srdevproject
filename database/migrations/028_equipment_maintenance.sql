ALTER TABLE equipment ADD COLUMN availability_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE app_equipment_outage (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(equipmentid),
  reason TEXT NOT NULL CHECK (reason IN ('repair','maintenance','safety','other')),
  staff_note VARCHAR(500) NOT NULL DEFAULT '',
  expected_back DATE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_by INTEGER NOT NULL REFERENCES "user"(userid),
  ended_at TIMESTAMPTZ,
  ended_by INTEGER REFERENCES "user"(userid),
  return_note VARCHAR(500),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX app_equipment_one_open_outage ON app_equipment_outage(equipment_id) WHERE ended_at IS NULL;
CREATE INDEX app_equipment_outage_history ON app_equipment_outage(equipment_id,started_at DESC);
CREATE INDEX app_equipment_live_grants ON app_device_access_event(target_id,expires_at) WHERE allowed AND target_kind='equipment';
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_equipment_outage
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_equipment_outage
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
