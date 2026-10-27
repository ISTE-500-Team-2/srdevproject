-- Existing accounts keep their email login and do not receive invented usernames.
ALTER TABLE "user" ADD COLUMN username VARCHAR(30);
ALTER TABLE "user" ADD CONSTRAINT user_username_format CHECK (
  username IS NULL OR username ~ '^[a-z0-9][a-z0-9_.-]{2,29}$'
);
CREATE UNIQUE INDEX user_username_unique ON "user" (lower(username)) WHERE username IS NOT NULL;
