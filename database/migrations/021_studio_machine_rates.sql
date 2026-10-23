-- New bookings use the approved rates; existing rental amounts stay unchanged.
UPDATE app_studio
SET monthly_cents = CASE size
  WHEN 'small' THEN 35000
  WHEN 'medium' THEN 75000
  WHEN 'large' THEN 120000
END,
revision = revision + 1;

-- Update existing named machines, including legacy names such as Spock and Kirk.
-- Add a catalog entry only when a machine type does not exist yet.
DO $$
DECLARE item RECORD;
BEGIN
  PERFORM setval('app_equipment_id_seq', GREATEST(
    (SELECT COALESCE(MAX(equipmentid),0) + 1 FROM equipment),
    (SELECT last_value FROM app_equipment_id_seq)
  ), false);
  FOR item IN SELECT * FROM (VALUES
    ('3D Printer', '3D printing', '3d[ -]*(printer|print)', 7.00, '/assets/3d-printer.webp', false),
    ('Laser', 'Laser cutting', 'laser', 20.00, '/assets/laser-engraver.webp', false),
    ('CNC Machine', 'CNC machining', 'cnc', 28.00, '/assets/cnc-machine.webp', true),
    ('Wood Lathe', 'Wood turning', 'wood[ -]*lathe', 12.00, '/assets/wood-lathe.webp', true),
    ('Metal Lathe', 'Metal turning', 'metal[ -]*lathe', 20.00, '/assets/wood-lathe.webp', true)
  ) AS rates(name, category, pattern, rate, image, waiver_required) LOOP
    IF NOT EXISTS(SELECT 1 FROM equipment WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern) THEN
      INSERT INTO equipment(name,category,hourlyrate,imagepath,status,waiverrequired,location)
      VALUES(item.name,item.category,item.rate,item.image,'available',item.waiver_required,'Makerspace');
    END IF;
    UPDATE equipment SET hourlyrate = item.rate
    WHERE lower(name || ' ' || COALESCE(category,'')) ~ item.pattern;
  END LOOP;
END $$;
