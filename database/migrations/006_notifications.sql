-- Additive notification foundation. Unknown waiver expiration is not invented.
ALTER TABLE user_waiver ADD COLUMN expires_at TIMESTAMPTZ;
CREATE TABLE app_notification_preferences (
  userid INTEGER PRIMARY KEY REFERENCES "user"(userid) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  time_zone TEXT NOT NULL DEFAULT 'America/New_York',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE app_notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  userid INTEGER NOT NULL REFERENCES "user"(userid) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','suppressed','failed','uncertain','obsolete')),
  counts_for_sla BOOLEAN NOT NULL DEFAULT true,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX app_notification_due ON app_notification_outbox(due_at,id) WHERE status='pending';
CREATE INDEX app_notification_user ON app_notification_outbox(userid,created_at DESC);
CREATE TABLE app_notification_delivery_event (
  event_key TEXT PRIMARY KEY,
  outbox_id BIGINT NOT NULL REFERENCES app_notification_outbox(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
