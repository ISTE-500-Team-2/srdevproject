-- CON-001: hardware changes need administrative approval. Adding, renaming, moving or turning on
-- a card reader, and guided reader setup, now check `reader:update` instead of `user_access:update`.
-- Only administrators get it (they already pass every check; the row records the rule). Staff
-- keep `user_access:update` for card scans and assignments and may still turn a reader off.
-- Grant `reader:update` to another role here to delegate reader configuration.
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
SELECT r.roleid,p.permissionid,'reader','global',TRUE FROM role r JOIN permission p ON p.permissionname='update'
WHERE r.role='admin' ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO NOTHING;
