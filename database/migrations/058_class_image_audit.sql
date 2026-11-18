-- Class pictures follow the same bounded storage and change-history rules as equipment pictures.
ALTER TABLE app_class_image ADD CONSTRAINT app_class_image_version CHECK (version ~ '^[A-Za-z0-9_-]{22}$');
ALTER TABLE app_class_image ADD CONSTRAINT app_class_image_size CHECK (octet_length(image) BETWEEN 1 AND 65536);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_class_image
FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_class_image
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
