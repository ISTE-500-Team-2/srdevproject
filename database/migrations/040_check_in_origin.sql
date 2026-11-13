-- Check-in origin was inferred from the human-readable status text, so a wording
-- change could reclassify history. Store it instead. The column is nullable with
-- no default so the previous release can keep inserting during a blue-green
-- switch; readers fall back to the old text rule for rows without an origin
-- (backend/src/models/checkInOrigin.ts).
ALTER TABLE check_in ADD COLUMN origin TEXT
  CONSTRAINT app_check_in_origin CHECK (origin IN ('nfc','portal'));
-- Existing rows are not backfilled: the fallback already classifies them, and an
-- UPDATE would hold this table's lock while writing one audit row per check-in.
