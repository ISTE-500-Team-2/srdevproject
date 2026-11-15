-- Members change their own sign-in email and password. A new email waits here until the new
-- address opens its emailed link; only a hash of that link's token is stored.
ALTER TABLE "user" ADD COLUMN password_changed_at TIMESTAMPTZ;
CREATE TABLE app_email_change (
  userid INTEGER PRIMARY KEY REFERENCES "user"(userid) ON DELETE CASCADE,
  new_email VARCHAR(100) NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_email_change
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('userid');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_email_change
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
