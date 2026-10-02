-- Sort before 010_room_reservation_conflicts.sql without changing its checksum.
-- Also applies to databases where that migration was already recorded. The
-- runner visits all unapplied filenames, including newly added earlier files.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS room (
  roomid INTEGER PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  location VARCHAR(100) NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  statusdesc VARCHAR(255)
);
CREATE SEQUENCE IF NOT EXISTS app_room_id_seq;
SELECT setval('app_room_id_seq', GREATEST(
  COALESCE((SELECT MAX(roomid) + 1 FROM room), 1),
  (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM app_room_id_seq)
), false);
ALTER SEQUENCE app_room_id_seq OWNED BY room.roomid;
ALTER TABLE room ALTER COLUMN roomid SET DEFAULT nextval('app_room_id_seq'::regclass);
ALTER TABLE reservation ADD COLUMN IF NOT EXISTS roomid INTEGER REFERENCES room(roomid);
ALTER TABLE check_in ADD COLUMN IF NOT EXISTS roomid INTEGER REFERENCES room(roomid);
ALTER TABLE check_in ALTER COLUMN location TYPE VARCHAR(203);

-- Grandfather existing bookings, including historical confirmed rows and old
-- resource-less records. No reservation times, owners or statuses are rewritten.
ALTER TABLE reservation ADD COLUMN cooldown_enforced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reservation ALTER COLUMN cooldown_enforced SET DEFAULT true;
ALTER TABLE reservation DROP CONSTRAINT IF EXISTS app_reservation_one_resource;
ALTER TABLE reservation ADD CONSTRAINT app_reservation_one_resource
  CHECK (NOT cooldown_enforced OR num_nonnulls(equipmentid, roomid) = 1);

ALTER TABLE reservation DROP CONSTRAINT IF EXISTS app_equipment_reservation_user_cooldown;
ALTER TABLE reservation DROP CONSTRAINT IF EXISTS app_room_reservation_user_cooldown;
-- Keep the original names: the following immutable migration skips these
-- constraints, and the HTTP error handler continues mapping them to cooldowns.
-- Despite its historical name, the equipment constraint is resource-wide.
ALTER TABLE reservation ADD CONSTRAINT app_equipment_reservation_user_cooldown
  EXCLUDE USING gist (
    equipmentid WITH =,
    tsrange(starttime, endtime + INTERVAL '15 minutes', '[)') WITH &&
  ) WHERE (cooldown_enforced AND equipmentid IS NOT NULL AND status IN ('confirmed','pending'));
ALTER TABLE reservation ADD CONSTRAINT app_room_reservation_user_cooldown
  EXCLUDE USING gist (
    userid WITH =,
    roomid WITH =,
    tsrange(starttime, endtime + INTERVAL '15 minutes', '[)') WITH &&
  ) WHERE (cooldown_enforced AND roomid IS NOT NULL AND status IN ('confirmed','pending'));

-- Exclusions cover new-vs-new races. This trigger checks new/changed bookings
-- against grandfathered rows. Exempt rows can only stay unchanged or leave the
-- active set; inserts, reschedules and reactivations always become enforced.
-- Therefore a concurrent writer cannot introduce a new exempt blocker.
CREATE FUNCTION app_enforce_reservation_cooldown() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cooldown_enforced := true;
  ELSE
    NEW.cooldown_enforced := OLD.cooldown_enforced
      OR ROW(NEW.userid, NEW.equipmentid, NEW.roomid, NEW.starttime, NEW.endtime)
         IS DISTINCT FROM ROW(OLD.userid, OLD.equipmentid, OLD.roomid, OLD.starttime, OLD.endtime)
      OR (COALESCE(NEW.status IN ('confirmed','pending'), false)
          AND NOT COALESCE(OLD.status IN ('confirmed','pending'), false));
  END IF;

  IF NEW.cooldown_enforced AND NEW.status IN ('confirmed','pending') THEN
    -- Classify actual overlap first, matching the service's error precedence.
    IF EXISTS (
      SELECT 1 FROM reservation r
      WHERE NOT r.cooldown_enforced AND r.reservationid <> NEW.reservationid
        AND r.status IN ('confirmed','pending')
        AND ((NEW.equipmentid IS NOT NULL AND r.equipmentid = NEW.equipmentid)
          OR (NEW.roomid IS NOT NULL AND r.roomid = NEW.roomid))
        AND r.starttime < NEW.endtime AND r.endtime > NEW.starttime
    ) THEN
      RAISE EXCEPTION 'That resource is already reserved for part of this time.'
        USING ERRCODE = '23P01', CONSTRAINT = CASE WHEN NEW.roomid IS NULL
          THEN 'app_reservation_no_overlap' ELSE 'app_room_reservation_no_overlap' END;
    END IF;

    IF NEW.equipmentid IS NOT NULL AND EXISTS (
      SELECT 1 FROM reservation r
      WHERE NOT r.cooldown_enforced AND r.reservationid <> NEW.reservationid
        AND r.equipmentid = NEW.equipmentid AND r.status IN ('confirmed','pending')
        AND r.starttime < NEW.endtime + INTERVAL '15 minutes'
        AND r.endtime > NEW.starttime - INTERVAL '15 minutes'
    ) THEN
      RAISE EXCEPTION 'Leave at least 15 minutes between reservations for the same equipment.'
        USING ERRCODE = '23P01', CONSTRAINT = 'app_equipment_reservation_user_cooldown';
    END IF;

    IF NEW.roomid IS NOT NULL AND EXISTS (
      SELECT 1 FROM reservation r
      WHERE NOT r.cooldown_enforced AND r.reservationid <> NEW.reservationid
        AND r.userid = NEW.userid AND r.roomid = NEW.roomid
        AND r.status IN ('confirmed','pending')
        AND r.starttime < NEW.endtime + INTERVAL '15 minutes'
        AND r.endtime > NEW.starttime - INTERVAL '15 minutes'
    ) THEN
      RAISE EXCEPTION 'Leave at least 15 minutes between your reservations for the same room.'
        USING ERRCODE = '23P01', CONSTRAINT = 'app_room_reservation_user_cooldown';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_reservation_cooldown_guard
  BEFORE INSERT OR UPDATE ON reservation
  FOR EACH ROW EXECUTE FUNCTION app_enforce_reservation_cooldown();

-- Mirror the personal equipment-catalog grants. Never replace an explicit deny.
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
  SELECT r.roleid,p.permissionid,'room','personal',true
  FROM role r JOIN permission p ON p.permissionname='read'
  WHERE r.role IN ('member','subscriber','day_pass','instructor','staff')
  ON CONFLICT(roleid,permissionid,resourcename,scopetype) DO NOTHING;
