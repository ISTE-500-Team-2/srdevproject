CREATE TABLE app_refresh_family (
 id UUID PRIMARY KEY, userid INT NOT NULL REFERENCES "user"(userid), csrf_token TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, persistent BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE app_refresh_token (
 token_hash CHAR(64) PRIMARY KEY, family_id UUID NOT NULL REFERENCES app_refresh_family(id) ON DELETE CASCADE,
 consumed BOOLEAN NOT NULL DEFAULT FALSE);
ALTER TABLE app_session ADD COLUMN family_id UUID REFERENCES app_refresh_family(id) ON DELETE CASCADE;
CREATE INDEX app_session_family_idx ON app_session(family_id);
CREATE INDEX app_refresh_token_family_idx ON app_refresh_token(family_id);
-- Old access cookies lack the required role claims and refresh family; users must sign in again.
