-- Run ONLY on an isolated test database populated by the DDL/seed scripts.
\set ON_ERROR_STOP on
BEGIN;
-- Reproduce the pre-DOB schema without changing the committed test fixture.
ALTER TABLE public."user" DROP COLUMN IF EXISTS dob;
CREATE TEMP TABLE before_dob AS SELECT to_jsonb(u) AS row FROM public."user" u;
\ir ../migrations/005_user_dob.sql
\ir ../migrations/005_user_dob.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user' AND column_name='dob'
      AND data_type='date' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'DOB must be a nullable DATE';
  END IF;
  IF EXISTS (SELECT 1 FROM public."user" WHERE dob IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy users must retain unknown DOB';
  END IF;
  IF EXISTS ((SELECT row FROM before_dob EXCEPT ALL SELECT to_jsonb(u)-'dob' FROM public."user" u)
      UNION ALL (SELECT to_jsonb(u)-'dob' FROM public."user" u EXCEPT ALL SELECT row FROM before_dob)) THEN
    RAISE EXCEPTION 'Migration changed existing user data';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."user") THEN
    RAISE EXCEPTION 'Test requires seeded users';
  END IF;
  UPDATE public."user" SET dob=DATE '2000-02-29';
  IF EXISTS (SELECT 1 FROM public."user" WHERE dob IS DISTINCT FROM DATE '2000-02-29') THEN
    RAISE EXCEPTION 'Calendar date did not round-trip';
  END IF;
  BEGIN
    EXECUTE 'UPDATE public."user" SET dob=''2001-02-29''::date';
    RAISE EXCEPTION 'Invalid calendar date was accepted';
  EXCEPTION WHEN datetime_field_overflow THEN NULL;
  END;
END $$;
ROLLBACK;
\echo DOB migration checks passed: type, nullability, repeatability, preserved rows, valid/invalid dates.
