-- Cover tables added on main after the original audit migration was deployed.
DO $$
DECLARE tab RECORD; key_column TEXT;
BEGIN
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('app_staff_audit','app_migration') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=format('public.%I',tab.tablename)::regclass AND tgname='app_capture_change') THEN
      SELECT a.attname INTO key_column FROM pg_index i
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=format('public.%I',tab.tablename)::regclass
          AND i.indisprimary AND i.indnatts=1 AND a.atttypid IN (20,21,23) LIMIT 1;
      EXECUTE format('CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_capture_change(%L)',tab.tablename,COALESCE(key_column,''));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=format('public.%I',tab.tablename)::regclass AND tgname='app_no_unlogged_truncate') THEN
      EXECUTE format('CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation()',tab.tablename);
    END IF;
  END LOOP;
END $$;
