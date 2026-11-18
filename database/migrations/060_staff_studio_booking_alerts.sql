-- Staff and administrators get a copy of every studio booking and cancellation. This lets each of
-- them stop those copies without turning off all email, which would also stop their own receipts
-- (NFR-003). Everyone keeps getting them until they choose otherwise.
-- The constant default is metadata-only, so existing rows are not rewritten.
ALTER TABLE app_notification_preferences ADD COLUMN studio_booking_alerts BOOLEAN NOT NULL DEFAULT true;
