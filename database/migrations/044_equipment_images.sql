-- Shared catalog pictures live in the database so backups and container replacements retain them.
-- Content hashes deduplicate uploads; equipment.imagepath remains a short, stable image URL.
CREATE TABLE app_equipment_image (
  version TEXT PRIMARY KEY CHECK (version ~ '^[A-Za-z0-9_-]{22}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/webp')),
  image BYTEA NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_equipment_image
FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_equipment_image
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
