-- Sign-ins without Remember me now last at most 12 hours (browserSessionLifetimeSeconds).
-- Sessions created before this change were given 30 days; cap them at 12 hours from now.
UPDATE app_refresh_family
SET expires_at = LEAST(expires_at, NOW() + INTERVAL '12 hours')
WHERE NOT persistent AND NOT revoked;
