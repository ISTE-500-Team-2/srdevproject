CREATE TABLE IF NOT EXISTS permission (
 permissionid INT PRIMARY KEY, permissionname VARCHAR(50) NOT NULL UNIQUE, description VARCHAR(255));
CREATE TABLE IF NOT EXISTS role_permission (
 rolepermissionid INT PRIMARY KEY, roleid INT NOT NULL REFERENCES role(roleid),
 permissionid INT NOT NULL REFERENCES permission(permissionid), resourcename VARCHAR(50) NOT NULL,
 scopetype VARCHAR(20) NOT NULL DEFAULT 'personal' CHECK (scopetype IN ('global','personal')),
 isallowed BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE(roleid,permissionid,resourcename,scopetype));
CREATE SEQUENCE IF NOT EXISTS app_role_permission_id_seq;
SELECT setval('app_role_permission_id_seq', GREATEST(COALESCE((SELECT MAX(rolepermissionid) FROM role_permission),0)+1,1),false);
ALTER TABLE role_permission ALTER COLUMN rolepermissionid SET DEFAULT nextval('app_role_permission_id_seq');
INSERT INTO permission(permissionid,permissionname) VALUES (1,'create'),(2,'read'),(3,'update'),(4,'delete') ON CONFLICT DO NOTHING;
-- Roles use their names, not assumed numeric IDs. No changes to existing deny rows.
INSERT INTO role(roleid,role,description) VALUES (4,'staff','Staff') ON CONFLICT DO NOTHING;
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
 SELECT r.roleid,p.permissionid,grants.resource,'global',TRUE
 FROM role r CROSS JOIN (VALUES
 ('plan','create'),('plan','update'),('user','update'),('user_access','update'),
 ('entitlement','create'),('entitlement','update'),('payment','update'),
 ('reservation','create'),('reservation','update')) AS grants(resource,action)
 JOIN permission p ON p.permissionname=grants.action
 WHERE r.role='staff' ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO NOTHING;
-- Waiver/training write grants intentionally unchanged pending BR-011 / FR-046-047 reconciliation.
