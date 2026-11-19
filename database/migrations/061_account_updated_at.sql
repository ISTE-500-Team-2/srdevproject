-- When an account record last changed, for the staff member record next to its sign-up date.
-- Only changes staff would call an account update move it: name, contact details, birth date,
-- account status, facility access, conduct flag and roles (role edits always bump revision).
-- Password changes, email confirmation and sign-in housekeeping do not.
ALTER TABLE "user" ADD COLUMN updated_at TIMESTAMPTZ;

-- Existing accounts: the latest staff account change in the change log (profile, account status,
-- facility access, conduct flag or roles, each logged by the application under its own action),
-- else the sign-up date. Accounts with neither stay empty rather than show a made-up date.
-- The database trigger's generic "Database change" rows are not used: they can't tell a profile
-- edit from a password rehash, reset or email confirmation, which don't count. So a member's own
-- profile edits before this release aren't reflected, and backfilled dates are approximate (never
-- later than the real last change). Computed before the trigger below exists, so this backfill
-- does not stamp every account with the migration time.
-- The audit capture trigger is paused for the backfill only: it would otherwise add a permanent
-- "Database change" row for every account. Migrations run as the table owner, as for 052/053.
ALTER TABLE "user" DISABLE TRIGGER app_capture_change;
UPDATE "user" u SET updated_at=COALESCE(
  (SELECT MAX(a.created_at) FROM app_staff_audit a
    WHERE a.subject_id=u.userid AND a.entity_type='user' AND a.entity_id=u.userid
      AND a.source='application'
      AND (a.action IN ('user.profile_updated','user.role_changed')
        OR a.action LIKE 'user.account\_%' OR a.action LIKE 'user.access\_%' OR a.action LIKE 'user.conduct\_%')),
  u.registration_date AT TIME ZONE 'UTC');
ALTER TABLE "user" ENABLE TRIGGER app_capture_change;

-- New accounts start out updated when they were made.
ALTER TABLE "user" ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE OR REPLACE FUNCTION app_touch_user_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.firstname,NEW.lastname,NEW.email,NEW.phone,NEW.dob,NEW.username,NEW.status,NEW.statusdesc,
      NEW.accessstatus,NEW.accessreason,NEW.conductflag,NEW.primary_role,NEW.is_student,
      NEW.profile_address,NEW.contact_preferences,NEW.revision)
    IS DISTINCT FROM
     (OLD.firstname,OLD.lastname,OLD.email,OLD.phone,OLD.dob,OLD.username,OLD.status,OLD.statusdesc,
      OLD.accessstatus,OLD.accessreason,OLD.conductflag,OLD.primary_role,OLD.is_student,
      OLD.profile_address,OLD.contact_preferences,OLD.revision) THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER app_touch_user_updated_at BEFORE UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION app_touch_user_updated_at();
