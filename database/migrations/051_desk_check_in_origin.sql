-- Staff check-ins at the front desk now write a check_in row (backend/src/minorSupervision.ts).
-- Store them as 'desk' so the Today board and reports do not show them as members checking
-- themselves in on the portal. Widening the check keeps every existing row valid, and the
-- previous release never writes 'desk', so a blue-green switch is unaffected.
ALTER TABLE check_in DROP CONSTRAINT app_check_in_origin,
  ADD CONSTRAINT app_check_in_origin CHECK (origin IN ('nfc','portal','desk')) NOT VALID;
-- New rows are checked immediately. Validate existing rows in backend/src/scripts/online-migrations.ts.
