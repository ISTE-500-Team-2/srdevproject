-- Signed waiver copies are legal records, so they get their own table instead of
-- living only in the notification outbox, where cleanup could remove them.
CREATE TABLE IF NOT EXISTS app_signed_waiver_copy (
  userwaiverid INTEGER PRIMARY KEY REFERENCES user_waiver(userwaiverid) ON DELETE CASCADE,
  userid INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Same metadata-only change capture as every other table (ids, never payloads).
CREATE OR REPLACE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_signed_waiver_copy
  FOR EACH ROW EXECUTE FUNCTION app_capture_change('userwaiverid');
CREATE OR REPLACE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_signed_waiver_copy
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();

-- Earlier signatures: keep the copy that was queued with the signing notice,
-- matched the same way the signed-waiver records page reads it.
INSERT INTO app_signed_waiver_copy (userwaiverid, userid, payload, created_at)
SELECT uw.userwaiverid, uw.userid, o.payload, o.created_at
FROM app_notification_outbox o
JOIN user_waiver uw ON o.dedupe_key = 'waiver-signed:' || uw.userwaiverid AND o.userid = uw.userid
WHERE o.kind = 'waiver_signed' AND o.dedupe_key ~ '^waiver-signed:[0-9]+$'
ON CONFLICT (userwaiverid) DO NOTHING;
