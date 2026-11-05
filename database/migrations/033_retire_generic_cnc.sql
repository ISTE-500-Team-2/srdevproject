-- Retire superseded catalog entries for deployments that only run migrations
-- (same rule as scripts/configure-mvp-catalog.ts, which stays idempotent with this).
-- The generic "CNC Machine" from 021 is retired only once Joey, Ross and Chandler
-- all exist. Rows are kept so bookings, payments and audit history still resolve;
-- app_capture_change records each change as a system (database) change.
WITH obsolete AS (
  SELECT equipmentid FROM equipment
  WHERE name='Welding Station'
    OR (name='CNC Machine' AND (SELECT count(DISTINCT name) FROM equipment WHERE name IN ('Joey','Ross','Chandler'))=3)
), retired AS (
  INSERT INTO app_equipment_retirement(equipment_id,reason)
  SELECT equipmentid,'MVP catalog cleanup: obsolete entry; booking and payment history retained' FROM obsolete
  ON CONFLICT(equipment_id) DO NOTHING RETURNING equipment_id
)
UPDATE equipment SET status='unavailable',availability_revision=availability_revision+1
WHERE equipmentid IN (SELECT equipment_id FROM retired);
