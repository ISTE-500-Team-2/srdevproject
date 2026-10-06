-- Device access is opt-in; no existing NFC assignments or check-ins are changed.
CREATE TABLE app_access_card (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES "user"(userid),
 uid_hash CHAR(64) NOT NULL UNIQUE,
 label VARCHAR(100) NOT NULL,
 active BOOLEAN NOT NULL DEFAULT true,
 revision INTEGER NOT NULL DEFAULT 1,
 assigned_by INTEGER NOT NULL REFERENCES "user"(userid),
 assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE app_device_access_event (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 reader_id TEXT NOT NULL,
 request_id UUID NOT NULL,
 user_id INTEGER REFERENCES "user"(userid),
 target_kind TEXT NOT NULL,
 target_id INTEGER,
 allowed BOOLEAN NOT NULL,
 reason TEXT NOT NULL,
 expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(reader_id,request_id)
);
CREATE INDEX app_device_event_time ON app_device_access_event(created_at DESC);
CREATE TABLE app_access_override (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES "user"(userid),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('equipment','room')),
 target_id INTEGER NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL,
 reason TEXT NOT NULL,
 created_by INTEGER NOT NULL REFERENCES "user"(userid),
 revoked_at TIMESTAMPTZ
);
-- Application-level append-only history, not protection against the DB owner.
CREATE FUNCTION app_audit_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit history is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER app_staff_audit_immutable BEFORE UPDATE OR DELETE ON app_staff_audit FOR EACH ROW EXECUTE FUNCTION app_audit_append_only();
CREATE TRIGGER app_staff_audit_no_truncate BEFORE TRUNCATE ON app_staff_audit FOR EACH STATEMENT EXECUTE FUNCTION app_audit_append_only();
CREATE INDEX app_staff_audit_actor_time ON app_staff_audit(actor_id,created_at DESC);
CREATE INDEX app_staff_audit_action_time ON app_staff_audit(action,created_at DESC);
