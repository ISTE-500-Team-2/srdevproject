-- Reader link health, reported by the gateway inside each signed heartbeat. A
-- heartbeat alone only proves the gateway is up; these rows record whether the
-- gateway could reach the reader itself. The latest report lives on the reader
-- (not audited: it is telemetry, not configuration). Samples are written on
-- change or once a minute and kept for eight days; events summarize changes.
ALTER TABLE app_access_reader ADD COLUMN health JSONB;
ALTER TABLE app_access_reader ADD COLUMN health_reported_at TIMESTAMPTZ;

CREATE TABLE app_reader_health_sample (
 id BIGSERIAL PRIMARY KEY,
 reader_id VARCHAR(64) NOT NULL REFERENCES app_access_reader(id) ON DELETE CASCADE,
 sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reachable BOOLEAN NOT NULL,
 ready BOOLEAN,
 door_state TEXT CHECK (door_state IN ('locked','checking','approved','denied','issue')),
 rssi SMALLINT CHECK (rssi BETWEEN -127 AND 0),
 address VARCHAR(45),
 firmware VARCHAR(64),
 uptime_ms BIGINT CHECK (uptime_ms >= 0),
 last_contact_ms INTEGER CHECK (last_contact_ms >= 0)
);
CREATE INDEX app_reader_health_sample_time ON app_reader_health_sample(reader_id,sampled_at DESC);

CREATE TABLE app_reader_health_event (
 id BIGSERIAL PRIMARY KEY,
 reader_id VARCHAR(64) NOT NULL REFERENCES app_access_reader(id) ON DELETE CASCADE,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 kind TEXT NOT NULL CHECK (kind IN ('unreachable','reachable','address_changed','firmware_changed',
   'restarted','weak_signal','reader_fault','reader_ready')),
 detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX app_reader_health_event_time ON app_reader_health_event(reader_id,occurred_at DESC);

-- Telemetry is append-only. Like the reader's last_seen_at, routine samples and
-- their retention pruning are not audited; altering a recorded row is, and the
-- tables cannot be truncated without an audit trail.
CREATE TRIGGER app_capture_change AFTER UPDATE ON app_reader_health_sample
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_reader_health_sample
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
CREATE TRIGGER app_capture_change AFTER UPDATE ON app_reader_health_event
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_reader_health_event
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
