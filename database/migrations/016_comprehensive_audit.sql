-- Automatic events contain metadata only: never credentials, tokens or row payloads.
ALTER TABLE app_staff_audit ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE app_staff_audit ADD COLUMN source TEXT NOT NULL DEFAULT 'application';
ALTER TABLE app_staff_audit ADD COLUMN database_actor TEXT NOT NULL DEFAULT session_user;

CREATE TRIGGER app_staff_audit_no_truncate
BEFORE TRUNCATE ON app_staff_audit
FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();

CREATE FUNCTION app_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior JSONB; subsequent JSONB; item JSONB; identity_value INTEGER;
  subject INTEGER; actor INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN subsequent := to_jsonb(NEW); END IF;
  item := COALESCE(subsequent, prior);
  actor := NULLIF(current_setting('app.actor_id', true), '')::integer;
  subject := COALESCE(item->>'userid',item->>'user_id')::integer;
  -- Composite/non-numeric keys are deliberately not copied into logs (session keys
  -- and provider tokens can be primary keys). Zero denotes a table-level identity.
  identity_value := COALESCE(item->>(TG_ARGV[0]),'0')::integer;
  INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,source)
  VALUES(actor,CASE WHEN EXISTS(SELECT 1 FROM "user" WHERE userid=subject) THEN subject ELSE NULL END,lower(TG_TABLE_NAME || '.' || TG_OP),TG_TABLE_NAME,identity_value,
    'Database change', 'database');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE tab RECORD; key_column TEXT;
BEGIN
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('app_staff_audit','app_migration') LOOP
    SELECT a.attname INTO key_column FROM pg_index i
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=format('public.%I',tab.tablename)::regclass
        AND i.indisprimary AND i.indnatts=1 AND a.atttypid IN (20,21,23) LIMIT 1;
    EXECUTE format('CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_capture_change(%L)',tab.tablename,COALESCE(key_column,''));
    -- TRUNCATE bypasses row triggers, so application tables must use DELETE.
    EXECUTE format('CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation()',tab.tablename);
  END LOOP;
END $$;
