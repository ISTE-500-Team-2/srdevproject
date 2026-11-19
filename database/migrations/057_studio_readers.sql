-- A reader can guard a rented studio (resource_id is app_studio.id). Taps there open only for the
-- member with a current paid rental of that studio. Every existing reader already passes the
-- widened check, so NOT VALID is unnecessary and the brief lock only rechecks the few reader rows.
ALTER TABLE app_access_reader DROP CONSTRAINT IF EXISTS app_access_reader_kind_check;
ALTER TABLE app_access_reader ADD CONSTRAINT app_access_reader_kind_check
  CHECK (kind IN ('building','room','equipment','studio'));
