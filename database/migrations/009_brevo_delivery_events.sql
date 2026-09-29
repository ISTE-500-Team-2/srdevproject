-- Retain callbacks that can arrive before the provider send response is saved.
CREATE TABLE app_brevo_delivery_event (
  event_key TEXT PRIMARY KEY,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX app_brevo_message ON app_brevo_delivery_event(provider_message_id);
CREATE VIEW app_notification_delivery_status AS
  SELECT o.id AS outbox_id,o.userid,o.provider_message_id,o.status AS sending_status,
    e.event_type,e.occurred_at
  FROM app_notification_outbox o LEFT JOIN app_brevo_delivery_event e
    ON e.provider_message_id=trim(both '<>' from o.provider_message_id);
