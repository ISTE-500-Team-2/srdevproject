-- Additive only: existing certifications, assignments and dates are preserved.
ALTER TABLE certifications ADD COLUMN validity_days INTEGER CHECK(validity_days BETWEEN 1 AND 3650);
ALTER TABLE certifications ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_certifications ADD COLUMN trained_at TIMESTAMPTZ;
ALTER TABLE user_certifications ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE user_certifications ADD COLUMN approved_by INTEGER REFERENCES "user"(userid);
ALTER TABLE user_certifications ADD COLUMN verification_reference TEXT;
ALTER TABLE user_certifications ADD COLUMN training_source TEXT CHECK(training_source IN ('equipment','external'));
ALTER TABLE user_certifications ADD COLUMN verified_in_person BOOLEAN;
ALTER TABLE user_certifications ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
-- Preserve deliberate permission denies. Instructors can certify; staff can maintain
-- definitions and revoke but cannot attest that they conducted in-person training.
INSERT INTO role_permission(roleid,permissionid,resourcename,scopetype,isallowed)
SELECT r.roleid,p.permissionid,'certification','global',TRUE FROM role r JOIN permission p ON
 ((r.role='instructor' AND p.permissionname IN ('read','create','update')) OR
  (r.role='staff' AND p.permissionname IN ('create','update')))
WHERE r.role IN ('instructor','staff') ON CONFLICT DO NOTHING;
