-- Catalog defaults and session images can be edited independently. Revisions protect staff drafts.
ALTER TABLE app_class_catalog ADD COLUMN imagepath VARCHAR(255);
ALTER TABLE app_class_catalog ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_training_class ADD COLUMN imagepath VARCHAR(255);
CREATE TABLE app_class_image (
  version VARCHAR(22) PRIMARY KEY,
  content_type VARCHAR(32) NOT NULL CHECK (content_type IN ('image/jpeg','image/webp')),
  image BYTEA NOT NULL
);
