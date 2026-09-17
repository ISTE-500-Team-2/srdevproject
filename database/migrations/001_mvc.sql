-- Additive MVC support. Apply through the migration runner, never through the
-- destructive legacy DDL scripts on an existing database.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS certid INTEGER REFERENCES certifications(certid);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS hourlyrate NUMERIC(10,2) CHECK (hourlyrate >= 0);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS imagepath VARCHAR(255);
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS location VARCHAR(100) NOT NULL DEFAULT 'Makerspace';
ALTER TABLE waiver ADD COLUMN IF NOT EXISTS isactive BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE waiver ADD COLUMN IF NOT EXISTS required BOOLEAN NOT NULL DEFAULT true;

-- Keep existing IDs and data; supply defaults for new application inserts.
DO $$
DECLARE item TEXT[]; seq TEXT; maximum BIGINT;
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ARRAY['user','userid'], ARRAY['user_role','rid'], ARRAY['user_membership','membershipid'],
    ARRAY['day_pass','dayid'], ARRAY['user_waiver','userwaiverid'], ARRAY['waiver','waiverid'],
    ARRAY['check_in','checkinid'], ARRAY['reservation','reservationid'], ARRAY['equipment','equipmentid']
  ] LOOP
    seq := 'app_' || item[1] || '_id_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I',seq);
    EXECUTE format('SELECT COALESCE(MAX(%I),0)+1 FROM %I',item[2],item[1]) INTO maximum;
    PERFORM setval(seq::regclass,GREATEST(maximum,1),false);
    EXECUTE format('ALTER SEQUENCE %I OWNED BY %I.%I',seq,item[1],item[2]);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT nextval(%L::regclass)',item[1],item[2],seq);
  END LOOP;
END $$;

CREATE TABLE app_session (
  token_hash CHAR(64) PRIMARY KEY,
  userid INTEGER NOT NULL REFERENCES "user"(userid) ON DELETE CASCADE,
  csrf_token CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX app_session_expiry ON app_session(expires_at);
CREATE INDEX app_session_user ON app_session(userid);
CREATE UNIQUE INDEX app_user_email_case_insensitive ON "user"(lower(email));
CREATE UNIQUE INDEX app_signed_waiver_unique ON user_waiver(userid,waiverid) WHERE approval=true;
CREATE INDEX app_reservation_user_time ON reservation(userid,starttime DESC);
CREATE INDEX app_check_in_user_time ON check_in(userid,checkintime DESC);

ALTER TABLE reservation ADD CONSTRAINT app_reservation_valid_window CHECK (endtime > starttime);
-- Half-open ranges allow a new booking to begin exactly when another ends.
-- The database also protects writers outside the API from overlapping bookings.
ALTER TABLE reservation ADD CONSTRAINT app_reservation_no_overlap
  EXCLUDE USING gist (equipmentid WITH =, tsrange(starttime,endtime,'[)') WITH &&)
  WHERE (status IN ('confirmed','pending'));
