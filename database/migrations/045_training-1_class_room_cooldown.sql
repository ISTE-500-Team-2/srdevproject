-- The room cooldown is per member: one person leaves 15 minutes between their own bookings of a
-- room. A class's room booking is stored under the staff member who scheduled it, so the same
-- rule stopped one staff member from scheduling back-to-back classes in a room (and reported a
-- double booking as a cooldown). Class scheduling (backend/src/trainingClasses.ts) now inserts
-- its room booking with cooldown_enforced=false; this keeps that value for a room-only insert.
-- Equipment bookings, inserts that leave the column at its default, and every update behave as
-- before. The room no-overlap exclusion still applies to every booking, exempt or not.
CREATE OR REPLACE FUNCTION app_enforce_reservation_cooldown() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cooldown_enforced := NEW.cooldown_enforced OR NEW.roomid IS NULL OR NEW.equipmentid IS NOT NULL;
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
