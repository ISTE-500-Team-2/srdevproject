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

-- Machines: rename only exact, known names, so a row never takes on another
-- machine's identity. Each target lists its own name, any legacy name, and a
-- generic placeholder whose type matches. "CNC Machine" does not say which size
-- it is, so it is left for staff to name. Customized names are never touched.
DO $$
DECLARE
  item RECORD;
  target INTEGER;
  source RECORD;
BEGIN
  PERFORM setval('app_equipment_id_seq', GREATEST(
    (SELECT COALESCE(MAX(equipmentid),0) + 1 FROM equipment),
    (SELECT last_value FROM app_equipment_id_seq)
  ), false);
  FOR item IN SELECT * FROM (VALUES
    ('Rachel', '3D printer', ARRAY['rachel','rachel (3d printer)','3d printer'], '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Phoebe', '3D printer', ARRAY['phoebe','3d printer'], '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Monica', '3D printer', ARRAY['monica','3d printer'], '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Darth Vader', 'Laser engraver', ARRAY['darth vader','laser'], 'laser', 20.00, '/assets/laser-engraver.webp', false),
    ('Kirk', 'Metal lathe', ARRAY['kirk','kirk (metal lathe)','metal lathe'], 'metal[ -]*lathe', 20.00, '/assets/wood-lathe.webp', true),
    ('Spock', 'Wood lathe', ARRAY['spock','spock (wood lathe)','wood lathe'], 'wood[ -]*lathe', 12.00, '/assets/wood-lathe.webp', true),
    ('Joey', 'Large CNC', ARRAY['joey','joey (large cnc)'], 'cnc', 28.00, '/assets/cnc-machine.webp', true),
    ('Ross', 'Small CNC', ARRAY['ross'], 'cnc', 28.00, '/assets/cnc-machine.webp', true),
    ('Chandler', 'Small CNC', ARRAY['chandler'], 'cnc', 28.00, '/assets/cnc-machine.webp', true)
  ) AS machines(name, category, sources, family, rate, image, waiver_required) LOOP
    SELECT equipmentid INTO target FROM equipment
    WHERE lower(name) = ANY(item.sources)
    ORDER BY array_position(item.sources, lower(name)), equipmentid
    LIMIT 1;

    IF target IS NOT NULL THEN
      -- Keep the row's own rate, waiver, certification and location.
      UPDATE equipment
      SET name = item.name, category = item.category,
        hourlyrate = COALESCE(hourlyrate, item.rate), imagepath = COALESCE(imagepath, item.image)
      WHERE equipmentid = target;
      CONTINUE;
    END IF;

    -- A new machine follows the policy of one already configured for its type:
    -- a same-category sibling first, then any machine of the same family.
    SELECT hourlyrate, location, certid, waiverrequired, buildingid INTO source FROM equipment
    WHERE category = item.category ORDER BY equipmentid LIMIT 1;
    IF NOT FOUND THEN
      SELECT hourlyrate, location, certid, waiverrequired, buildingid INTO source FROM equipment
      WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.family ORDER BY equipmentid LIMIT 1;
    END IF;
    INSERT INTO equipment(name,category,hourlyrate,imagepath,status,waiverrequired,location,certid,buildingid)
    VALUES (item.name, item.category, COALESCE(source.hourlyrate, item.rate), item.image, 'available',
      COALESCE(source.waiverrequired, item.waiver_required), COALESCE(source.location, 'Makerspace'),
      source.certid, COALESCE(source.buildingid, 1));
  END LOOP;
END $$;
