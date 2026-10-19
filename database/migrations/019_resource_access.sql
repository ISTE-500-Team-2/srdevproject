CREATE TABLE building (
  buildingid INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','unavailable'))
);
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON building
FOR EACH ROW EXECUTE FUNCTION app_capture_change('buildingid');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON building
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
INSERT INTO building(name) VALUES ('Collaboratory');
ALTER TABLE room ADD COLUMN buildingid INTEGER NOT NULL DEFAULT 1 REFERENCES building(buildingid);
ALTER TABLE equipment ADD COLUMN buildingid INTEGER NOT NULL DEFAULT 1 REFERENCES building(buildingid);
ALTER TABLE check_in ADD COLUMN buildingid INTEGER REFERENCES building(buildingid);
ALTER TABLE check_in ADD COLUMN equipmentid INTEGER REFERENCES equipment(equipmentid);
ALTER TABLE check_in ADD COLUMN reservationid INTEGER REFERENCES reservation(reservationid);
ALTER TABLE app_access_override ADD COLUMN reservationid INTEGER REFERENCES reservation(reservationid);
ALTER TABLE app_access_override ADD COLUMN owns_reservation BOOLEAN NOT NULL DEFAULT false;

-- Invalidate captured tokens permanently, including changes made outside the API.
CREATE FUNCTION app_revoke_blocked_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' OR NEW.accessstatus <> 'active' THEN
    UPDATE app_refresh_family SET revoked=true WHERE userid=NEW.userid AND NOT revoked;
    DELETE FROM app_session WHERE userid=NEW.userid;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_revoke_blocked_sessions AFTER UPDATE OF status,accessstatus ON "user"
FOR EACH ROW EXECUTE FUNCTION app_revoke_blocked_sessions();
UPDATE app_refresh_family f SET revoked=true FROM "user" u
WHERE f.userid=u.userid AND (u.status IS DISTINCT FROM 'active' OR u.accessstatus<>'active');
DELETE FROM app_session s USING "user" u WHERE s.userid=u.userid
AND (u.status IS DISTINCT FROM 'active' OR u.accessstatus<>'active');
