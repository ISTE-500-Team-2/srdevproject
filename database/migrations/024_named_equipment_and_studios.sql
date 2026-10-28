-- Give every studio and machine its makerspace name. Rows are renamed in place
-- so reservations, rentals and check-ins keep pointing at the same records.

-- Studios: only rename the original placeholder names, never a staff edit.
UPDATE app_studio s
SET name = renamed.name, revision = s.revision + 1
FROM (VALUES
  ('Small studio 1', 'Harkonnen'),
  ('Small studio 2', 'Atreides'),
  ('Small studio 3', 'Corrine'),
  ('Medium studio 1', 'Coruscant'),
  ('Medium studio 2', 'Alderaan'),
  ('Medium studio 3', 'Corellia'),
  ('Large studio 1', 'Paris'),
  ('Large studio 2', 'Big Apple')
) AS renamed(old_name, name)
WHERE s.name = renamed.old_name
  AND NOT EXISTS (SELECT 1 FROM app_studio taken WHERE taken.name = renamed.name);

-- Machines: reuse a row already carrying the name (e.g. 'Rachel (3D printer)'),
-- then an unnamed row of the same type (e.g. '3D Printer'), else add the machine.
DO $$
DECLARE
  item RECORD;
  target INTEGER;
  named TEXT[] := ARRAY['rachel','phoebe','monica','darth vader','kirk','spock','joey','ross','chandler'];
BEGIN
  PERFORM setval('app_equipment_id_seq', GREATEST(
    (SELECT COALESCE(MAX(equipmentid),0) + 1 FROM equipment),
    (SELECT last_value FROM app_equipment_id_seq)
  ), false);
  FOR item IN SELECT * FROM (VALUES
    ('Rachel', '3D printer', '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Phoebe', '3D printer', '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Monica', '3D printer', '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Darth Vader', 'Laser engraver', 'laser', 20.00, '/assets/laser-engraver.webp', false),
    ('Kirk', 'Metal lathe', 'metal[ -]*lathe', 20.00, '/assets/wood-lathe.webp', true),
    ('Spock', 'Wood lathe', 'wood[ -]*lathe', 12.00, '/assets/wood-lathe.webp', true),
    ('Joey', 'Large CNC', 'cnc', 28.00, '/assets/cnc-machine.webp', true),
    ('Ross', 'Small CNC', 'cnc', 28.00, '/assets/cnc-machine.webp', true),
    ('Chandler', 'Small CNC', 'cnc', 28.00, '/assets/cnc-machine.webp', true)
  ) AS machines(name, category, pattern, rate, image, waiver_required) LOOP
    SELECT equipmentid INTO target FROM equipment
    WHERE lower(name) = lower(item.name) OR lower(name) LIKE lower(item.name) || ' (%'
    ORDER BY equipmentid LIMIT 1;

    IF target IS NULL THEN
      SELECT equipmentid INTO target FROM equipment
      WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern
        AND lower(split_part(name, ' (', 1)) <> ALL(named)
      ORDER BY equipmentid LIMIT 1;
    END IF;

    IF target IS NULL THEN
      INSERT INTO equipment(name,category,hourlyrate,imagepath,status,waiverrequired,location,certid)
      SELECT item.name, item.category,
        COALESCE((SELECT MAX(hourlyrate) FROM equipment WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern), item.rate),
        item.image, 'available', item.waiver_required,
        COALESCE((SELECT location FROM equipment WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern ORDER BY equipmentid LIMIT 1), 'Makerspace'),
        (SELECT certid FROM equipment WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern AND certid IS NOT NULL ORDER BY equipmentid LIMIT 1);
    ELSE
      UPDATE equipment
      SET name = item.name, category = item.category,
        hourlyrate = COALESCE(hourlyrate, item.rate), imagepath = COALESCE(imagepath, item.image)
      WHERE equipmentid = target;
    END IF;
  END LOOP;
END $$;
