-- Only an already-confirmed, active owner can become the first administrator.
-- This script does not create a password or bypass email confirmation.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'));
SELECT (
  (SELECT count(*) FROM "user" WHERE lower(email)=lower(:'owner_email') AND email_confirmed AND status='active')=1
  AND NOT EXISTS (
    SELECT 1 FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid)
    WHERE r.role='admin' AND u.status='active'
  )
) AS owner_ready \gset
\if :owner_ready
SELECT userid AS owner_id FROM "user"
WHERE lower(email)=lower(:'owner_email') AND email_confirmed AND status='active' \gset
INSERT INTO user_role(userid,roleid,assignedat)
SELECT u.userid,r.roleid,NOW() AT TIME ZONE 'UTC'
FROM "user" u CROSS JOIN role r
WHERE u.userid=:'owner_id' AND r.role='admin'
ON CONFLICT(userid,roleid) DO NOTHING;
UPDATE "user" SET primary_role='admin',revision=revision+1
WHERE userid=:'owner_id';
INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,after_state)
SELECT userid,userid,'user.first_admin_bootstrap','user',userid,
  'Owner-approved initial administrator setup',jsonb_build_object('primaryRole','admin')
FROM "user" WHERE userid=:'owner_id';
COMMIT;
\echo First administrator approved. Sign out and sign back in to refresh your role.
\else
ROLLBACK;
\echo STOP: owner not confirmed/active, or an active administrator already exists. No role changed.
DO $$ BEGIN RAISE EXCEPTION 'First administrator preconditions not met; no role changed'; END $$;
\endif
