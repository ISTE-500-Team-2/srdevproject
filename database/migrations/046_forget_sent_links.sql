-- Password-reset, sign-up confirmation and email-change emails carry a one-time token in their link.
-- The token tables keep only a hash, but the outbox needs the whole link until the email is handed to
-- the provider. Once a row leaves 'pending'/'sending' (accepted, failed, suppressed, obsolete or
-- uncertain) nothing reads the link again, so drop it: the database and its backups then never hold
-- a usable reset or confirmation token. The rest of the payload (hashes, expiry) is kept.
CREATE OR REPLACE FUNCTION app_forget_sent_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.payload := NEW.payload - 'resetUrl' - 'confirmationUrl';
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS app_forget_sent_link ON app_notification_outbox;
CREATE TRIGGER app_forget_sent_link BEFORE INSERT OR UPDATE OF status ON app_notification_outbox
  FOR EACH ROW WHEN (NEW.status NOT IN ('pending','sending') AND (NEW.payload ? 'resetUrl' OR NEW.payload ? 'confirmationUrl'))
  EXECUTE FUNCTION app_forget_sent_link();

-- Online phase in backend/src/scripts/online-migrations.ts: clear previously sent links in batches.
