-- A person's own profile photo: one small square image their browser has already cropped and
-- re-encoded. Kept in PostgreSQL so existing backups and restores carry it. `version` is a
-- content hash the browser uses to tell a changed photo from a cached one.
CREATE TABLE app_user_photo (
  user_id INTEGER PRIMARY KEY REFERENCES "user"(userid) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/webp')),
  image BYTEA NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 65536),
  version TEXT NOT NULL CHECK (version ~ '^[A-Za-z0-9_-]{1,64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_user_photo
FOR EACH ROW EXECUTE FUNCTION app_capture_change('user_id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_user_photo
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
