-- Removing a workshop hides it from the catalog while retaining session and audit history.
ALTER TABLE app_class_catalog ADD COLUMN removed_at TIMESTAMPTZ;
