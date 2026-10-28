-- Additive onboarding state only. Existing readers/cards/access policies untouched.
CREATE TABLE app_reader_setup_gateway (
  id TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE app_reader_setup_receipt (
  gateway_id TEXT NOT NULL REFERENCES app_reader_setup_gateway(id),
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(gateway_id,event_id)
);
CREATE INDEX app_reader_setup_receipt_expiry ON app_reader_setup_receipt(created_at);
CREATE TABLE app_reader_setup_device (
  gateway_id TEXT NOT NULL REFERENCES app_reader_setup_gateway(id),
  device_id TEXT NOT NULL,
  model TEXT NOT NULL,
  firmware TEXT,
  transport TEXT NOT NULL CHECK(transport IN ('usb','network')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(gateway_id,device_id)
);
CREATE TABLE app_reader_setup_job (
  id UUID PRIMARY KEY,
  gateway_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reader_id TEXT NOT NULL UNIQUE REFERENCES app_access_reader(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
    ('queued','backing_up','connecting','pairing','verifying','complete','failed','cancelled','expired')),
  payload_encrypted TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes',
  FOREIGN KEY(gateway_id,device_id) REFERENCES app_reader_setup_device(gateway_id,device_id)
);
CREATE UNIQUE INDEX app_reader_setup_one_active_device ON app_reader_setup_job(gateway_id,device_id)
  WHERE status NOT IN ('failed','cancelled','expired');
