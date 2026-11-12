-- Service notices remember how many people each one reached and what members
-- were told when it was fixed, so the staff page can show both.
ALTER TABLE app_service_notice ADD COLUMN recipients INTEGER CHECK (recipients >= 0);
ALTER TABLE app_service_notice ADD COLUMN resolution TEXT;

-- Earlier notices: count the emails that were queued for them, and recover the
-- "what was fixed" note from the change log, where it was the only copy. Each
-- source is read once and joined in, so a large email queue stays one pass.
UPDATE app_service_notice n SET recipients=COALESCE(sent.total,0)
FROM app_service_notice m LEFT JOIN (
  SELECT split_part(o.dedupe_key,':',2)::bigint AS notice_id, COUNT(*)::integer AS total
  FROM app_notification_outbox o
  WHERE o.kind='system_issue' AND o.status<>'suppressed' AND o.dedupe_key ~ '^system_issue:[0-9]{1,18}:'
  GROUP BY 1
) sent ON sent.notice_id=m.id
WHERE n.id=m.id;
UPDATE app_service_notice n SET resolution=fixed.reason
FROM (
  SELECT DISTINCT ON (a.entity_id) a.entity_id, a.reason FROM app_staff_audit a
  WHERE a.action='service_notice.resolved' AND a.entity_type='app_service_notice'
  ORDER BY a.entity_id, a.id DESC
) fixed
WHERE fixed.entity_id=n.id AND n.source='staff' AND n.resolved_at IS NOT NULL;

-- The page lists notices newest first and counts a reader's recent drop-outs.
CREATE INDEX app_service_notice_opened ON app_service_notice(opened_at DESC, id DESC);
CREATE INDEX app_service_notice_reader_opened ON app_service_notice(reader_id, opened_at DESC) WHERE reader_id IS NOT NULL;
