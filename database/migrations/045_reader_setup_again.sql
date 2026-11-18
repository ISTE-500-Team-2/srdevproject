-- A reader that finished guided setup can be set up again (new Wi-Fi, a reset or a move).
-- Only a setup still in progress blocks another for the same device; finishing the new one
-- turns off the reader it replaces. Existing jobs and readers are unchanged.
DROP INDEX IF EXISTS app_reader_setup_one_active_device;
CREATE UNIQUE INDEX app_reader_setup_one_active_device ON app_reader_setup_job(gateway_id,device_id)
  WHERE status NOT IN ('complete','failed','cancelled','expired');
