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
SELECT setval(
  'app_room_id_seq',
  GREATEST(COALESCE((SELECT MAX(roomid) + 1 FROM room), 1), 1),
  false
);
ALTER SEQUENCE app_room_id_seq OWNED BY room.roomid;
ALTER TABLE room ALTER COLUMN roomid SET DEFAULT nextval('app_room_id_seq'::regclass);

ALTER TABLE reservation ADD COLUMN IF NOT EXISTS roomid INTEGER REFERENCES room(roomid);
ALTER TABLE check_in ADD COLUMN IF NOT EXISTS roomid INTEGER REFERENCES room(roomid);
CREATE INDEX IF NOT EXISTS app_reservation_room_time ON reservation(roomid,starttime DESC);
CREATE INDEX IF NOT EXISTS app_check_in_room_time ON check_in(roomid,checkintime DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_reservation_one_resource'
  ) THEN
    ALTER TABLE reservation ADD CONSTRAINT app_reservation_one_resource
      CHECK (num_nonnulls(equipmentid, roomid) = 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_room_reservation_no_overlap'
  ) THEN
    ALTER TABLE reservation ADD CONSTRAINT app_room_reservation_no_overlap
      EXCLUDE USING gist (roomid WITH =, tsrange(starttime,endtime,'[)') WITH &&)
      WHERE (roomid IS NOT NULL AND status IN ('confirmed','pending'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_equipment_reservation_user_cooldown'
  ) THEN
    ALTER TABLE reservation ADD CONSTRAINT app_equipment_reservation_user_cooldown
      EXCLUDE USING gist (
        userid WITH =,
        equipmentid WITH =,
        tsrange(starttime - INTERVAL '15 minutes', endtime + INTERVAL '15 minutes','[)') WITH &&
      )
      WHERE (equipmentid IS NOT NULL AND status IN ('confirmed','pending'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_room_reservation_user_cooldown'
  ) THEN
    ALTER TABLE reservation ADD CONSTRAINT app_room_reservation_user_cooldown
      EXCLUDE USING gist (
        userid WITH =,
        roomid WITH =,
        tsrange(starttime - INTERVAL '15 minutes', endtime + INTERVAL '15 minutes','[)') WITH &&
      )
      WHERE (roomid IS NOT NULL AND status IN ('confirmed','pending'));
  END IF;
END $$;
