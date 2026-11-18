-- The previous worker claims status='pending' AND due_at<=now. Keep the normal queue status
-- for its metrics and writers, but place jobs it cannot send beyond its claim horizon.
CREATE FUNCTION app_notification_worker_compatibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status='pending' AND (
      NEW.kind IN (
        'account_exists',
        'membership_cancellation_confirmed',
        'reservation_cancelled_by_staff',
        'admin_studio_reservation_confirmed',
        'admin_studio_reservation_cancelled'
      ) OR (NEW.kind='password_reset' AND EXISTS (
        SELECT 1 FROM "user" WHERE userid=NEW.userid AND status='pending'
      ))
    ) THEN
      NEW.worker_v2_due_at := NEW.due_at;
      NEW.due_at := 'infinity';
    END IF;
  ELSIF OLD.worker_v2_due_at IS NOT NULL THEN
    IF OLD.status='pending' AND NEW.status='suppressed' AND NEW.kind='account_exists' THEN
      -- The previous opt-out SQL does not know this is an account-security notice.
      RETURN NULL;
    ELSIF NEW.status IN ('pending','sending') THEN
      IF NEW.due_at<>'infinity' THEN
        NEW.worker_v2_due_at := NEW.due_at;
        NEW.due_at := 'infinity';
      END IF;
    ELSE
      NEW.due_at := OLD.worker_v2_due_at;
      NEW.worker_v2_due_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The previous release never enqueues these kinds or issues a reset to a pending account.
-- No backfill or index build is needed. Fail immediately if another transaction holds the table.
LOCK TABLE app_notification_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE app_notification_outbox ADD COLUMN worker_v2_due_at timestamptz;
CREATE TRIGGER app_notification_worker_compatibility
  BEFORE INSERT OR UPDATE OF status,due_at ON app_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION app_notification_worker_compatibility();
