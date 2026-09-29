-- Grandfather existing accounts; only public registration opts into confirmation.
ALTER TABLE "user" ADD COLUMN email_confirmed BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE app_email_confirmation (
  userid INTEGER PRIMARY KEY REFERENCES "user"(userid) ON DELETE CASCADE,
  token_hash CHAR(64) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
