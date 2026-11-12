-- Annual compliance applies to existing and future definitions and records.
UPDATE waiver SET validity_days=365;
ALTER TABLE waiver ALTER COLUMN validity_days SET DEFAULT 365;
ALTER TABLE waiver ALTER COLUMN validity_days SET NOT NULL;
ALTER TABLE waiver ADD CONSTRAINT waiver_annual_validity CHECK(validity_days=365);
UPDATE certifications SET validity_days=365;
ALTER TABLE certifications ALTER COLUMN validity_days SET DEFAULT 365;
ALTER TABLE certifications ALTER COLUMN validity_days SET NOT NULL;
ALTER TABLE certifications ADD CONSTRAINT certification_annual_validity CHECK(validity_days=365);

-- Preserve earlier explicit deadlines and immutable signed document copies.
UPDATE user_waiver SET expires_at=LEAST(expires_at,(signdate+INTERVAL '365 days') AT TIME ZONE 'UTC')
WHERE signdate IS NOT NULL AND (expires_at IS NULL OR expires_at>(signdate+INTERVAL '365 days') AT TIME ZONE 'UTC');
-- A signature with no recorded date gets at most a year from now, like training with no recorded date below.
-- Its start is kept on the row so staff expiry edits can count from it; the runtime role cannot read app_migration.
ALTER TABLE user_waiver ADD COLUMN undated_valid_from TIMESTAMPTZ;
UPDATE user_waiver SET undated_valid_from=NOW(),expires_at=LEAST(expires_at,NOW()+INTERVAL '365 days')
WHERE signdate IS NULL;
UPDATE user_certifications SET
  renewaldate=LEAST(renewaldate,(COALESCE(trained_at,approved_at,NOW()) AT TIME ZONE 'UTC')+INTERVAL '365 days'),
  revision=revision+1
WHERE renewaldate IS NULL OR renewaldate>(COALESCE(trained_at,approved_at,NOW()) AT TIME ZONE 'UTC')+INTERVAL '365 days';
