-- Public sign-ups are temporary requests, not users or members, until their inbox is verified.
CREATE TABLE app_pending_registration (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(100) NOT NULL UNIQUE,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  dob DATE NOT NULL,
  password_hash TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  token_hash CHAR(64) UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX app_pending_registration_expiry ON app_pending_registration(expires_at);

-- The existing leased email worker can deliver confirmation links without inventing a user ID.
ALTER TABLE app_notification_outbox ALTER COLUMN userid DROP NOT NULL;
ALTER TABLE app_notification_outbox ADD COLUMN registration_id BIGINT REFERENCES app_pending_registration(id) ON DELETE CASCADE;
ALTER TABLE app_notification_outbox ADD CONSTRAINT app_notification_recipient CHECK (
  (userid IS NOT NULL AND registration_id IS NULL) OR
  (userid IS NULL AND registration_id IS NOT NULL AND kind='account_confirmation')
);
CREATE INDEX app_notification_registration ON app_notification_outbox(registration_id) WHERE registration_id IS NOT NULL;

-- Preserve old unverified accounts and their links, but stop counting them as active members.
UPDATE "user" SET status='pending', statusdesc='Awaiting email confirmation'
WHERE email_confirmed=false AND status='active';

-- Preserve the repository's metadata-only audit coverage without logging pending contact details or hashes.
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_pending_registration
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_pending_registration
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
