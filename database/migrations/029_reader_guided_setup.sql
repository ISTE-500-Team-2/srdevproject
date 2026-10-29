-- Additive onboarding state only. Existing readers/cards/access policies untouched.
CREATE TABLE app_reader_setup_gateway (
  id TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_report_stamp BIGINT NOT NULL DEFAULT 0,
  last_report_id UUID
);
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
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '20 minutes',
  FOREIGN KEY(gateway_id,device_id) REFERENCES app_reader_setup_device(gateway_id,device_id)
);
CREATE UNIQUE INDEX app_reader_setup_one_active_device ON app_reader_setup_job(gateway_id,device_id)
  WHERE status NOT IN ('failed','cancelled','expired');

-- Business/identity changes are audited; routine liveness/replay counters are
-- not, matching app_access_reader's last_seen_at treatment. No credential or
-- encrypted Wi-Fi payload is copied into audit metadata.
CREATE TRIGGER app_capture_change AFTER INSERT OR DELETE ON app_reader_setup_gateway
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_capture_identity_change AFTER UPDATE OF id ON app_reader_setup_gateway
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_capture_change AFTER INSERT OR DELETE ON app_reader_setup_device
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_capture_metadata_change AFTER UPDATE OF gateway_id,device_id,model,firmware,transport ON app_reader_setup_device
 FOR EACH ROW WHEN (ROW(OLD.gateway_id,OLD.device_id,OLD.model,OLD.firmware,OLD.transport)
 IS DISTINCT FROM ROW(NEW.gateway_id,NEW.device_id,NEW.model,NEW.firmware,NEW.transport))
 EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_reader_setup_job
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_reader_setup_gateway
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_reader_setup_device
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_reader_setup_job
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
