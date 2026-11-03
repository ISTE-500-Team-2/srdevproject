-- Adult-initiated sponsor links: the adult asks, the minor confirms. Staff linking is unchanged.
CREATE TABLE app_minor_sponsor_request (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  minor_id INTEGER NOT NULL REFERENCES "user"(userid),
  adult_id INTEGER NOT NULL REFERENCES "user"(userid),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK(minor_id<>adult_id),
  CHECK((status='pending')=(resolved_at IS NULL))
);
CREATE UNIQUE INDEX app_minor_sponsor_request_pending ON app_minor_sponsor_request(minor_id,adult_id) WHERE status='pending';
CREATE INDEX app_minor_sponsor_request_adult ON app_minor_sponsor_request(adult_id) WHERE status='pending';
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_minor_sponsor_request
FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_minor_sponsor_request
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();

-- Every request attempt, so date-of-birth guessing is bounded across restarts and concurrent
-- requests. Only a SHA-256 of the lowercased target email is kept, never the address itself.
CREATE TABLE app_minor_sponsor_attempt (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adult_id INTEGER NOT NULL REFERENCES "user"(userid),
  email_hash TEXT NOT NULL,
  matched BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_minor_sponsor_attempt_adult ON app_minor_sponsor_attempt(adult_id,created_at);
CREATE INDEX app_minor_sponsor_attempt_email ON app_minor_sponsor_attempt(email_hash,created_at) WHERE NOT matched;
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_minor_sponsor_attempt
FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_minor_sponsor_attempt
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
