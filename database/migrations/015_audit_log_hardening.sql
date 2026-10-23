-- Compliance audit records are append-only. Corrections must be represented by
-- a new compensating event, preserving the original actor and timestamp.
CREATE FUNCTION app_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are immutable.' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER app_staff_audit_immutable
  BEFORE UPDATE OR DELETE ON app_staff_audit
  FOR EACH ROW EXECUTE FUNCTION app_reject_audit_mutation();

CREATE INDEX app_staff_audit_actor_time
  ON app_staff_audit(actor_id,created_at DESC,id DESC);
CREATE INDEX app_staff_audit_subject_time
  ON app_staff_audit(subject_id,created_at DESC,id DESC);
CREATE INDEX app_staff_audit_action_time
  ON app_staff_audit(action,created_at DESC,id DESC);
CREATE INDEX app_staff_audit_time
  ON app_staff_audit(created_at DESC,id DESC);
