INSERT INTO role(roleid,role,description) VALUES (1,'admin','Super administrator'),(2,'member','Community member'),(3,'student','Student classification'),(4,'staff','Staff') ON CONFLICT DO NOTHING;
-- Preserve legacy member/admin names as community-member/super-admin aliases.
INSERT INTO role(roleid,role,description)
SELECT (SELECT COALESCE(MAX(roleid),0) FROM role)+ROW_NUMBER() OVER (), name, description
FROM (VALUES ('subscriber','Monthly subscriber'),('day_pass','Day-pass customer'),('instructor','Instructor'),('student','Student classification only')) v(name,description)
WHERE NOT EXISTS(SELECT 1 FROM role WHERE role=v.name);
ALTER TABLE "user" ADD COLUMN primary_role VARCHAR(50) NOT NULL DEFAULT 'member';
ALTER TABLE "user" ADD COLUMN is_student BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "user" u SET primary_role=COALESCE((SELECT r.role FROM user_role ur JOIN role r USING(roleid)
 WHERE ur.userid=u.userid AND r.role <> 'student' ORDER BY CASE r.role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,r.role LIMIT 1),'member'),
 is_student=EXISTS(SELECT 1 FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid AND r.role='student');
INSERT INTO user_role(userid,roleid,assignedat) SELECT u.userid,r.roleid,NOW() AT TIME ZONE 'UTC'
FROM "user" u JOIN role r ON r.role=u.primary_role WHERE NOT EXISTS(SELECT 1 FROM user_role ur WHERE ur.userid=u.userid AND ur.roleid=r.roleid);
-- Customer scope never grants access to another person's records. Classification does not replace eligibility checks.
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
 SELECT r.roleid,p.permissionid,g.resource,'personal',TRUE FROM role r CROSS JOIN
 (VALUES ('reservation','create'),('reservation','read'),('reservation','update'),('user','read'),('user','update'),
 ('notification','read'),('notification','update'),('waiver','read'),('waiver','create'),('certification','read'),
 ('check_in','create'),('entitlement','read'),('payment','read'),('equipment','read'),('plan','read')) g(resource,action)
 JOIN permission p ON p.permissionname=g.action WHERE r.role IN ('member','subscriber','day_pass','instructor','staff')
 ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO NOTHING;
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
 SELECT r.roleid,p.permissionid,g.resource,'global',TRUE FROM role r CROSS JOIN
 (VALUES ('plan'),('user'),('waiver'),('payment'),('audit'),('policy'),('equipment'),('reservation'),('notification'),('certification'),('entitlement')) g(resource)
 JOIN permission p ON p.permissionname='read' WHERE r.role='staff'
 ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO NOTHING;
