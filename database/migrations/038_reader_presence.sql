-- Presence includes authenticated renewals as well as physical taps. Keep the
-- existing tap-only indexes for card history, and bound the all-event lookup.
CREATE INDEX app_device_event_reader_presence
  ON app_device_access_event(reader_id,created_at DESC);
