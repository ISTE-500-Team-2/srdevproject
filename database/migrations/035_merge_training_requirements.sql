-- Preserve the training policies configured on main before adopting the editable
-- certification pricing fields introduced on punchlistEdwin.
UPDATE certifications c
SET training_minutes=r.duration_minutes,training_fee_cents=r.fee_cents
FROM app_training_requirement r
WHERE r.certification_id=c.certid;

-- Main's trigger caps new classes while allowing legacy larger classes to be
-- edited. Keep that guard instead of the competing branch's ID-based check.
ALTER TABLE app_training_class DROP CONSTRAINT app_training_class_fifteen_seats;
