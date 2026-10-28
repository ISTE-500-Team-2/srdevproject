-- Preserve every assignment. Only the current assignment owns a card fingerprint.
ALTER TABLE app_access_card DROP CONSTRAINT app_access_card_uid_hash_key;
CREATE UNIQUE INDEX app_access_card_active_uid ON app_access_card(uid_hash) WHERE active;
ALTER TABLE app_access_card ADD COLUMN uid_last4 VARCHAR(4);

CREATE TABLE app_access_reader (
 id VARCHAR(64) PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('building','room','equipment')),
 resource_id INTEGER NOT NULL,
 secret_encrypted TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT true,
 revision INTEGER NOT NULL DEFAULT 1,
 last_seen_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE app_device_access_event ADD COLUMN uid_hash CHAR(64);
ALTER TABLE app_device_access_event ADD COLUMN uid_last4 VARCHAR(4);
ALTER TABLE app_device_access_event ADD COLUMN card_id INTEGER REFERENCES app_access_card(id);
ALTER TABLE app_device_access_event ADD COLUMN is_tap BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX app_device_event_card_time ON app_device_access_event(card_id,created_at DESC) WHERE is_tap;
CREATE INDEX app_device_event_reader_time ON app_device_access_event(reader_id,created_at DESC) WHERE is_tap;

CREATE TABLE app_card_enrollment (
 id UUID PRIMARY KEY,
 reader_id VARCHAR(64) NOT NULL REFERENCES app_access_reader(id),
 user_id INTEGER REFERENCES "user"(userid),
 actor_id INTEGER NOT NULL REFERENCES "user"(userid),
 purpose TEXT NOT NULL CHECK (purpose IN ('assign','lookup')),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '2 minutes'),
 uid_hash CHAR(64),
 uid_last4 VARCHAR(4),
 captured_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 cancelled_at TIMESTAMPTZ,
 CHECK ((purpose='assign' AND user_id IS NOT NULL) OR (purpose='lookup' AND user_id IS NULL))
);
CREATE UNIQUE INDEX app_card_enrollment_reader_pending ON app_card_enrollment(reader_id)
 WHERE completed_at IS NULL AND cancelled_at IS NULL;
-- Audits record metadata only, never the reader credential or card fingerprint.
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OF name,kind,resource_id,secret_encrypted,enabled,revision OR DELETE ON app_access_reader
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_access_reader
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_card_enrollment
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_card_enrollment
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
