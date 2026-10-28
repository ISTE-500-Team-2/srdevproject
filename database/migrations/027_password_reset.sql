CREATE TABLE app_password_reset (
  userid INTEGER PRIMARY KEY REFERENCES "user"(userid) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_password_reset
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('userid');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_password_reset
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
