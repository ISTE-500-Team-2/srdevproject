-- Retain the incident boundary: reusing pre-incident training is not re-certification.
ALTER TABLE user_certifications ADD COLUMN revoked_at TIMESTAMPTZ;
UPDATE user_certifications uc SET revoked_at=COALESCE(
  (SELECT MAX(created_at) FROM app_staff_audit
   WHERE entity_type='user_certification' AND entity_id=uc.usercertid AND action='training.revoked'),
  NOW()) WHERE status='revoked';

CREATE FUNCTION app_mark_training_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='revoked' THEN NEW.revoked_at=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_mark_training_revocation BEFORE INSERT OR UPDATE OF status ON user_certifications
FOR EACH ROW EXECUTE FUNCTION app_mark_training_revocation();
