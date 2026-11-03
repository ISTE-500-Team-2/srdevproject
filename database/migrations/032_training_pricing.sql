-- Keep historical classes editable without admitting new classes over 15 seats.
DO $$
DECLARE legacy_max INTEGER := (SELECT COALESCE(MAX(id),0) FROM app_training_class);
BEGIN
  EXECUTE format('ALTER TABLE app_training_class ADD CONSTRAINT app_training_class_fifteen_seats CHECK (capacity <= 15 OR id <= %s)', legacy_max);
END $$;

ALTER TABLE certifications ADD COLUMN training_fee_cents INTEGER DEFAULT 0
  CHECK (training_fee_cents BETWEEN 0 AND 10000000);
ALTER TABLE certifications ADD COLUMN training_minutes INTEGER NOT NULL DEFAULT 60
  CHECK (training_minutes BETWEEN 1 AND 480);
ALTER TABLE user_certifications ADD COLUMN training_minutes INTEGER
  CHECK (training_minutes BETWEEN 1 AND 480);
ALTER TABLE reservation ADD COLUMN price_snapshot JSONB;
ALTER TABLE reservation ADD COLUMN payment_id INTEGER UNIQUE REFERENCES payment(paymentid);

-- Approved starting courses: one hour, $20 on every equipment booking.
-- No certification expiry is invented.
-- Existing equipment policies and existing certificates remain intact.
DO $$
DECLARE course RECORD; cert INTEGER;
BEGIN
  FOR course IN SELECT * FROM (VALUES
    ('CNC', 'cnc'), ('Metal Lathe', 'metal[ -]*lathe'), ('Wood Lathe', 'wood[ -]*lathe')
  ) AS courses(name,pattern) LOOP
    SELECT certid INTO cert FROM certifications WHERE name=course.name ORDER BY certid LIMIT 1;
    IF cert IS NULL THEN
      SELECT COALESCE(MAX(certid),0)+1 INTO cert FROM certifications;
      INSERT INTO certifications(certid,name,description,effectivedate,training_fee_cents,training_minutes)
        VALUES(cert,course.name,'One-hour instructor-verified equipment training',now() AT TIME ZONE 'UTC',2000,60);
    END IF;
    UPDATE equipment SET certid=cert WHERE certid IS NULL
      AND (COALESCE(category,'')||' '||name) ~* course.pattern;
  END LOOP;
END $$;
