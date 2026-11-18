-- The previous release claims only 'pending' rows and cannot render the five new
-- kinds or deliver a reset to a pending account. Keep those jobs available to the
-- new worker during blue-green overlap and any rollback to the previous release.
ALTER TABLE app_notification_outbox
  DROP CONSTRAINT app_notification_outbox_status_check,
  ADD CONSTRAINT app_notification_outbox_status_check
    CHECK (status IN ('pending','pending_v2','sending','accepted','suppressed','failed','uncertain','obsolete'));

CREATE FUNCTION app_notification_requires_v2(notification_kind text, recipient_id integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT notification_kind IN (
    'account_exists',
    'membership_cancellation_confirmed',
    'reservation_cancelled_by_staff',
    'admin_studio_reservation_confirmed',
    'admin_studio_reservation_cancelled'
  ) OR (notification_kind='password_reset' AND EXISTS (
    SELECT 1 FROM "user" WHERE userid=recipient_id AND status='pending'
  ));
$$;

-- Apply the same rule to inserts and to every path that returns a claimed job to the queue.
CREATE FUNCTION app_notification_queue_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_notification_requires_v2(NEW.kind, NEW.userid) THEN
    NEW.status := 'pending_v2';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER app_notification_queue_status
  BEFORE INSERT OR UPDATE OF status ON app_notification_outbox
  FOR EACH ROW WHEN (NEW.status='pending')
  EXECUTE FUNCTION app_notification_queue_status();

-- A protected reset still needs its link until it is sent or reaches a terminal status.
DROP TRIGGER app_forget_sent_link ON app_notification_outbox;
CREATE TRIGGER app_forget_sent_link BEFORE INSERT OR UPDATE OF status ON app_notification_outbox
  FOR EACH ROW WHEN (NEW.status NOT IN ('pending','pending_v2','sending') AND (NEW.payload ? 'resetUrl' OR NEW.payload ? 'confirmationUrl'))
  EXECUTE FUNCTION app_forget_sent_link();

UPDATE app_notification_outbox SET status='pending_v2'
WHERE status='pending' AND app_notification_requires_v2(kind, userid);

DROP INDEX app_notification_due;
CREATE INDEX app_notification_due ON app_notification_outbox(due_at,id) WHERE status IN ('pending','pending_v2');
