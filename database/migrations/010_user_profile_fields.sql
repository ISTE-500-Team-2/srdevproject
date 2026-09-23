-- User-managed profile fields. JSON objects keep address/contact preferences
-- customizable without baking one fixed form into the schema.
ALTER TABLE "user" ADD COLUMN profile_address JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "user" ADD COLUMN contact_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "user" ADD COLUMN assholeflag BOOLEAN NOT NULL DEFAULT false;
