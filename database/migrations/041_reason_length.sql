-- Class scheduling and cancelling (backend/src/trainingClasses.ts) and training
-- record and revoke (backend/src/certifications.ts) accept reasons of up to 500
-- characters and store them in statusdesc, which was VARCHAR(255), so a longer
-- reason failed with a generic error. Widening a varchar keeps every existing
-- value and does not rewrite the table; the previous release writes at most 255.
ALTER TABLE reservation ALTER COLUMN statusdesc TYPE VARCHAR(500);
ALTER TABLE user_certifications ALTER COLUMN statusdesc TYPE VARCHAR(500);
