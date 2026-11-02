-- Additive application records: existing users, signatures, bookings and check-ins remain intact.
CREATE TABLE app_minor_sponsor (
  minor_id INTEGER PRIMARY KEY REFERENCES "user"(userid),
  adult_id INTEGER NOT NULL REFERENCES "user"(userid),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(minor_id<>adult_id)
);
CREATE INDEX app_minor_sponsor_adult ON app_minor_sponsor(adult_id);
CREATE TABLE app_facility_visit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES "user"(userid),
  building_id INTEGER NOT NULL REFERENCES building(buildingid),
  sponsor_id INTEGER REFERENCES "user"(userid),
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_out_at TIMESTAMPTZ,
  CHECK(checked_out_at IS NULL OR checked_out_at>=checked_in_at)
);
CREATE UNIQUE INDEX app_facility_visit_open ON app_facility_visit(user_id) WHERE checked_out_at IS NULL;
CREATE INDEX app_facility_visit_sponsor ON app_facility_visit(sponsor_id) WHERE checked_out_at IS NULL;
CREATE TABLE app_minor_booking (
  reservation_id INTEGER PRIMARY KEY REFERENCES reservation(reservationid),
  adult_id INTEGER NOT NULL REFERENCES "user"(userid)
);
CREATE TABLE app_minor_studio_booking (
  rental_id INTEGER PRIMARY KEY REFERENCES app_studio_rental(id),
  adult_id INTEGER NOT NULL REFERENCES "user"(userid)
);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_minor_sponsor
FOR EACH ROW EXECUTE FUNCTION app_capture_change('minor_id');
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_facility_visit
FOR EACH ROW EXECUTE FUNCTION app_capture_change('id');

DO $$ DECLARE tab text; key text; BEGIN
  FOREACH tab IN ARRAY ARRAY['app_minor_booking','app_minor_studio_booking'] LOOP
    key:=CASE WHEN tab='app_minor_booking' THEN 'reservation_id' ELSE 'rental_id' END;
    EXECUTE format('CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_capture_change(%L)',tab,key);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['app_minor_sponsor','app_facility_visit','app_minor_booking','app_minor_studio_booking'] LOOP
    EXECUTE format('CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation()',tab);
  END LOOP;
END $$;

ALTER TABLE app_training_enrollment ADD COLUMN sponsor_id INTEGER REFERENCES "user"(userid);
