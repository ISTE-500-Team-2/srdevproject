-- A signed waiver copy is the legal record of exactly what a member agreed to,
-- so once stored it can never be edited or removed. This also refuses deleting
-- a signature that has a copy, since that delete would cascade to the copy.
-- Truncation is already refused by 039. Like the audit log, this binds the
-- application and its runtime role, not the database owner.
CREATE OR REPLACE FUNCTION app_reject_signed_copy_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Signed waiver copies are permanent records and cannot be changed or deleted.'
    USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE TRIGGER app_signed_waiver_copy_permanent
  BEFORE UPDATE OR DELETE ON app_signed_waiver_copy
  FOR EACH ROW EXECUTE FUNCTION app_reject_signed_copy_change();
