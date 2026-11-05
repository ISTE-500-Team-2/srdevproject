-- B-015: an administrator can give a waiver a duration. NULL keeps today's
-- behavior, so no sponsor decision is invented here.
ALTER TABLE waiver ADD COLUMN validity_days INTEGER CHECK(validity_days BETWEEN 1 AND 3650);

-- FR-057: members can cancel a membership that has no card subscription behind it.
ALTER TABLE user_membership ADD COLUMN cancellation_requested_at TIMESTAMPTZ;

-- B-014: active records with no expiry date count as valid forever. Date them from
-- the recorded training when there is one, otherwise from today. Certifications
-- without an approved validity stay undated until an administrator sets one.
CREATE FUNCTION app_backfill_certification_expiry(target INTEGER) RETURNS INTEGER LANGUAGE sql AS $$
  WITH dated AS (
    UPDATE user_certifications uc SET
      renewaldate=(COALESCE(uc.trained_at,NOW()) AT TIME ZONE 'UTC')+make_interval(days=>c.validity_days),
      revision=uc.revision+1
    FROM certifications c
    WHERE c.certid=uc.certid AND uc.certid=target AND uc.status='active'
      AND uc.renewaldate IS NULL AND c.validity_days IS NOT NULL
    RETURNING uc.usercertid
  ) SELECT COUNT(*)::int FROM dated
$$;
SELECT app_backfill_certification_expiry(certid) FROM certifications WHERE validity_days IS NOT NULL;

-- FR-032: one open notice per silent reader, plus issues staff report by hand.
CREATE TABLE app_service_notice (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('reader','staff')),
  reader_id VARCHAR(64),
  summary TEXT NOT NULL,
  opened_by INTEGER REFERENCES "user"(userid),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by INTEGER REFERENCES "user"(userid),
  resolved_at TIMESTAMPTZ,
  CHECK((source='reader')=(reader_id IS NOT NULL))
);
CREATE UNIQUE INDEX app_service_notice_one_open_reader ON app_service_notice(reader_id) WHERE resolved_at IS NULL;
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_service_notice
FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_service_notice
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
