// Service notices (app_service_notice): staff announcements and reader-health alerts, plus who they
// reach. Callers pass the pool or their transaction client.

import type { Database } from "../db.js";
import { readerLastSeen, readerPresenceJoin } from "../readerRegistry.js";

// Readers report in far more often than this, so a brief network blip stays quiet.
const READER_SILENT_AFTER = "5 minutes";

const columns = `n.id,n.source,n.reader_id AS "readerId",n.summary,n.opened_at AS "openedAt",n.resolved_at AS "resolvedAt"`;
// What the staff page shows: who opened and fixed each notice, how many people it
// reached, and for card readers their current state and how often they dropped out.
const detail = `${columns},n.recipients,n.resolution,
  NULLIF(TRIM(COALESCE(ob.firstname,'') || ' ' || COALESCE(ob.lastname,'')),'') AS "openedBy",
  NULLIF(TRIM(COALESCE(rb.firstname,'') || ' ' || COALESCE(rb.lastname,'')),'') AS "resolvedBy",
  r.name AS "readerName",r.last_seen_at AS "readerLastSeenAt",
  CASE WHEN n.reader_id IS NULL THEN NULL ELSE (SELECT COUNT(*)::int FROM app_service_notice d
    WHERE d.reader_id=n.reader_id AND d.opened_at>NOW()-INTERVAL '24 hours') END AS "recentDrops"`;
const detailFrom = `app_service_notice n LEFT JOIN "user" ob ON ob.userid=n.opened_by
  LEFT JOIN "user" rb ON rb.userid=n.resolved_by LEFT JOIN app_access_reader r ON r.id=n.reader_id`;

export class ServiceNoticeModel {
  constructor(private db: Database) {}

  /** Active staff and administrators: who hears about reader alerts. */
  async staffAudience() {
    return (await this.db.query<{ userid: number }>(`SELECT DISTINCT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid)
    WHERE u.status='active' AND r.role IN ('staff','admin')`)).rows.map((row) => row.userid);
  }
  /** Every active account: who hears a staff announcement. */
  async everyone() {
    return (await this.db.query<{ userid: number }>(`SELECT userid FROM "user" WHERE status='active'`)).rows.map((row) => row.userid);
  }
  /** Of these accounts, how many will actually get the email: active and not opted out. */
  async reachable(audience: number[]) {
    return (await this.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "user" u LEFT JOIN app_notification_preferences p USING(userid)
    WHERE u.userid=ANY($1::int[]) AND u.status='active' AND COALESCE(p.enabled,true)`, [audience])).rows[0]?.count ?? 0;
  }

  /** Serializes reader-health checks until the caller's transaction ends. */
  async lockHealthCheck() {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-service-health'))");
  }
  /** Opens a notice for each enabled reader that has gone silent and has none open yet. */
  async openSilentReaders() {
    return (await this.db.query<{ id: number; reader_id: string; name: string }>(`WITH silent AS (
        SELECT r.id,r.name FROM app_access_reader r ${readerPresenceJoin}
        WHERE r.enabled AND ${readerLastSeen}<NOW()-INTERVAL '${READER_SILENT_AFTER}'
          AND NOT EXISTS(SELECT 1 FROM app_reader_setup_job j WHERE j.reader_id=r.id AND j.status<>'complete')
          AND NOT EXISTS(SELECT 1 FROM app_service_notice n WHERE n.reader_id=r.id AND n.resolved_at IS NULL)
      ), created AS (
        INSERT INTO app_service_notice(source,reader_id,summary)
        SELECT 'reader',id,name||' has stopped reporting in.' FROM silent RETURNING id,reader_id
      ) SELECT c.id,c.reader_id,s.name FROM created c JOIN silent s ON s.id=c.reader_id`)).rows;
  }
  /** Resolves reader notices whose reader is back, disabled or removed; `online` tells them apart. */
  async closeClearedReaders() {
    return (await this.db.query<{ id: number; reader_id: string; name: string | null; online: boolean }>(`WITH cleared AS (
        SELECT n.id,n.reader_id,r.name,r.enabled AND ${readerLastSeen}>=NOW()-INTERVAL '${READER_SILENT_AFTER}' AS online
        FROM app_service_notice n LEFT JOIN app_access_reader r ON r.id=n.reader_id
        ${readerPresenceJoin}
        WHERE n.reader_id IS NOT NULL AND n.resolved_at IS NULL
          AND (r.id IS NULL OR NOT r.enabled OR ${readerLastSeen}>=NOW()-INTERVAL '${READER_SILENT_AFTER}')
      ), updated AS (
        UPDATE app_service_notice n SET resolved_at=NOW() FROM cleared c WHERE n.id=c.id RETURNING n.id
      ) SELECT c.id,c.reader_id,c.name,COALESCE(c.online,false) AS online FROM cleared c JOIN updated u ON u.id=c.id`)).rows;
  }
  async setRecipients(ids: number[], recipients: number) {
    await this.db.query("UPDATE app_service_notice SET recipients=$2 WHERE id=ANY($1::int[])", [
      ids,
      recipients,
    ]);
  }

  /** Every unresolved notice, newest first. */
  async open() {
    return (await this.db.query(`SELECT ${detail} FROM ${detailFrom} WHERE n.resolved_at IS NULL ORDER BY n.opened_at DESC,n.id DESC`)).rows;
  }
  /** A page of resolved notices (51 rows, to tell whether more follow), each carrying the filtered total. */
  async history(period: string | null, source: string | null, offset: number) {
    return (await this.db.query(
      `SELECT ${detail},COUNT(*) OVER()::int AS total FROM ${detailFrom}
         WHERE n.resolved_at IS NOT NULL AND ($1::interval IS NULL OR n.opened_at>=NOW()-$1::interval)
           AND ($2::text IS NULL OR n.source=$2)
         ORDER BY n.opened_at DESC,n.id DESC LIMIT 51 OFFSET $3`,
      [period, source, offset],
    )).rows;
  }
  async openStaffNotice(summary: string, openedBy: number, recipients: number) {
    return (await this.db.query(
      `INSERT INTO app_service_notice AS n(source,summary,opened_by,recipients) VALUES('staff',$1,$2,$3) RETURNING ${columns},n.recipients`,
      [summary, openedBy, recipients],
    )).rows[0]!;
  }
  /** The notice, locked until the caller's transaction ends; undefined when it doesn't exist. */
  async findForUpdate(id: number) {
    return (await this.db.query(`SELECT ${columns},n.resolution FROM app_service_notice n WHERE n.id=$1 FOR UPDATE`, [id])).rows[0];
  }
  async resolve(id: number, resolvedBy: number, resolution: string) {
    return (await this.db.query(
      `UPDATE app_service_notice AS n SET resolved_at=NOW(),resolved_by=$2,resolution=$3 WHERE n.id=$1 RETURNING ${columns},n.resolution`,
      [id, resolvedBy, resolution],
    )).rows[0];
  }
}
