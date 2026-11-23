-- FR-006/FR-008: "Subscriber" and "Day-pass customer" now follow what each member actually holds.
-- They are read from the member's memberships and passes whenever an account is shown
-- (automaticRolesSql), so buying, cancelling, suspending or simply running out can't leave them
-- stale. Remove the hand-set copies. An account whose primary role was one of them falls back to
-- community member, so it keeps exactly one valid primary role (BR-004). The role rows and their
-- permissions stay: they match community member's and nothing assigns them any more.
-- Each changed account gets a change-log entry from the system. Running this again changes nothing.
WITH changed AS (
  SELECT u.userid,u.primary_role AS primary_before,
    COALESCE((SELECT jsonb_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING(roleid)
      WHERE ur.userid=u.userid),'[]'::jsonb) AS roles_before
  FROM "user" u
  WHERE u.primary_role IN ('subscriber','day_pass')
    OR EXISTS(SELECT 1 FROM user_role ur JOIN role r USING(roleid)
      WHERE ur.userid=u.userid AND r.role IN ('subscriber','day_pass'))
), outcome AS (
  SELECT c.*,CASE WHEN c.primary_before IN ('subscriber','day_pass') THEN 'member' ELSE c.primary_before END AS primary_after,
    -- Community member is added only where the account would otherwise lack its primary role or any role.
    (SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x),'[]'::jsonb) FROM (
      SELECT jsonb_array_elements_text(c.roles_before) AS x
      UNION SELECT 'member' WHERE c.primary_before IN ('subscriber','day_pass')
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.roles_before) k WHERE k NOT IN ('subscriber','day_pass'))
    ) kept WHERE x NOT IN ('subscriber','day_pass')) AS roles_after
  FROM changed c
), removed AS (
  DELETE FROM user_role ur USING role r
  WHERE r.roleid=ur.roleid AND r.role IN ('subscriber','day_pass') RETURNING ur.userid
), fallback AS (
  INSERT INTO user_role(userid,roleid,assignedat)
  SELECT o.userid,r.roleid,NOW() AT TIME ZONE 'UTC' FROM outcome o JOIN role r ON r.role='member'
  WHERE o.roles_after ? 'member' AND NOT o.roles_before ? 'member'
  RETURNING userid
), moved AS (
  UPDATE "user" u SET primary_role=o.primary_after,revision=u.revision+1
  FROM outcome o WHERE o.userid=u.userid RETURNING u.userid
)
INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,before_state,after_state)
SELECT NULL,o.userid,'user.role_changed','user',o.userid,
  'Subscriber and day-pass customer now follow the member''s memberships and passes automatically',
  jsonb_build_object('primaryRole',o.primary_before,'roles',o.roles_before),
  jsonb_build_object('primaryRole',o.primary_after,'roles',o.roles_after)
FROM outcome o JOIN moved m USING(userid);
