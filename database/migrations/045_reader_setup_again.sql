-- A reader that finished guided setup can be set up again (new Wi-Fi, a reset or a move).
-- Only a setup still in progress blocks another for the same device; finishing the new one
-- turns off the reader it replaces. Existing jobs and readers are unchanged.
-- The runner builds the replacement concurrently on an existing setup table.
-- This CREATE only builds on fresh databases, where the table is new in this transaction.
CREATE UNIQUE INDEX IF NOT EXISTS app_reader_setup_one_in_progress_device ON app_reader_setup_job(gateway_id,device_id)
  WHERE status NOT IN ('complete','failed','cancelled','expired');
DROP INDEX IF EXISTS app_reader_setup_one_active_device;
