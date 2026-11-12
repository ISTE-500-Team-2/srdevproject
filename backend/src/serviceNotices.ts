import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { StaffModel } from "./models/StaffModel.js";
import { enqueueNotification } from "./notifications/store.js";
import { readerLastSeen, readerPresenceJoin } from './readerRegistry.js';

// Readers report in far more often than this, so a brief network blip stays quiet.
const READER_SILENT_AFTER = "5 minutes";

const staffAudience = async (db: Database) =>
  (await db.query<{ userid: number }>(`SELECT DISTINCT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role r USING(roleid)
    WHERE u.status='active' AND r.role IN ('staff','admin')`)).rows.map((row) => row.userid);
const everyone = async (db: Database) =>
  (await db.query<{ userid: number }>(`SELECT userid FROM "user" WHERE status='active'`)).rows.map((row) => row.userid);

async function notify(db: Database, audience: number[], kind: "system_issue" | "service_restored", noticeId: number, payload: object) {
  for (const userId of audience)
    await enqueueNotification(db, { userId, kind, dedupeKey: `${kind}:${noticeId}:${userId}`, payload: { noticeId, ...payload } });
}

/** Tells staff when an enabled reader goes silent and again when it returns. The
 * server can only report what it can observe: its own outage needs outside monitoring. */
export async function checkReaderHealth(pool: Pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-service-health'))");
    const opened = (await db.query<{ id: number; reader_id: string; name: string }>(`WITH silent AS (
        SELECT r.id,r.name FROM app_access_reader r ${readerPresenceJoin}
        WHERE r.enabled AND ${readerLastSeen}<NOW()-INTERVAL '${READER_SILENT_AFTER}'
          AND NOT EXISTS(SELECT 1 FROM app_reader_setup_job j WHERE j.reader_id=r.id AND j.status<>'complete')
          AND NOT EXISTS(SELECT 1 FROM app_service_notice n WHERE n.reader_id=r.id AND n.resolved_at IS NULL)
      ), created AS (
        INSERT INTO app_service_notice(source,reader_id,summary)
        SELECT 'reader',id,name||' has stopped reporting in.' FROM silent RETURNING id,reader_id
      ) SELECT c.id,c.reader_id,s.name FROM created c JOIN silent s ON s.id=c.reader_id`)).rows;
    const closed = (await db.query<{ id: number; reader_id: string; name: string | null; online: boolean }>(`WITH cleared AS (
        SELECT n.id,n.reader_id,r.name,r.enabled AND ${readerLastSeen}>=NOW()-INTERVAL '${READER_SILENT_AFTER}' AS online
        FROM app_service_notice n LEFT JOIN app_access_reader r ON r.id=n.reader_id
        ${readerPresenceJoin}
        WHERE n.reader_id IS NOT NULL AND n.resolved_at IS NULL
          AND (r.id IS NULL OR NOT r.enabled OR ${readerLastSeen}>=NOW()-INTERVAL '${READER_SILENT_AFTER}')
      ), updated AS (
        UPDATE app_service_notice n SET resolved_at=NOW() FROM cleared c WHERE n.id=c.id RETURNING n.id
      ) SELECT c.id,c.reader_id,c.name,COALESCE(c.online,false) AS online FROM cleared c JOIN updated u ON u.id=c.id`)).rows;
    // A reader that staff disabled or removed is not a recovery worth announcing.
    const restored = closed.filter((notice) => notice.online);
    if (!opened.length && !restored.length) return;
    const audience = await staffAudience(db);
    for (const notice of opened)
      await notify(db, audience, "system_issue", notice.id, {
        readerId: notice.reader_id,
        location: notice.name,
        reason: "This card reader has stopped reporting in, so it is refusing access until it reconnects.",
        instructions: "Check the reader's power and network connection.",
      });
    for (const notice of restored)
      await notify(db, audience, "service_restored", notice.id, {
        readerId: notice.reader_id,
        location: notice.name,
        reason: "This card reader is reporting in again.",
      });
  });
}

const columns = `n.id,n.source,n.reader_id AS "readerId",n.summary,n.opened_at AS "openedAt",n.resolved_at AS "resolvedAt"`;

export function serviceNoticeRoutes(pool: Pool) {
  const router = Router();
  // Reaches every member's inbox, so only administrators can send one.
  const administrator = (res: Parameters<typeof authState>[0]) => {
    const { user } = authState(res);
    if (!user.roles.includes("admin"))
      throw new AppError(403, "ADMIN_REQUIRED", "Administrator permission is required.");
    return user;
  };
  router.get("/admin/service-notices", async (_req, res) => {
    res.json({
      data: (await pool.query(`SELECT ${columns} FROM app_service_notice n ORDER BY n.resolved_at IS NULL DESC,n.opened_at DESC,n.id DESC LIMIT 50`)).rows,
    });
  });
  router.post("/admin/service-notices", requireCsrf, async (req, res) => {
    const user = administrator(res);
    const summary = textField(req.body.summary, "Summary", 500, 5),
      reason = textField(req.body.reason, "Reason", 500);
    const data = await transaction(pool, async (db) => {
      const notice = (await db.query(
        `INSERT INTO app_service_notice AS n(source,summary,opened_by) VALUES('staff',$1,$2) RETURNING ${columns}`,
        [summary, user.id],
      )).rows[0];
      await new StaffModel(db).audit(user.id, null, "service_notice.opened", "app_service_notice", notice.id, reason, null, notice);
      await notify(db, await everyone(db), "system_issue", notice.id, { reason: summary });
      return notice;
    });
    res.status(201).json({ data });
  });
  router.post("/admin/service-notices/:id/resolve", requireCsrf, async (req, res) => {
    const user = administrator(res);
    const id = positiveId(req.params.id),
      reason = textField(req.body.reason, "Reason", 500);
    const data = await transaction(pool, async (db) => {
      const before = (await db.query(`SELECT ${columns} FROM app_service_notice n WHERE n.id=$1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new AppError(404, "NOT_FOUND", "Service notice not found.");
      if (before.resolvedAt) throw new AppError(409, "ALREADY_RESOLVED", "This notice was already resolved.");
      if (before.source !== "staff")
        throw new AppError(409, "AUTOMATIC_NOTICE", "This notice clears itself when the reader reconnects.");
      const after = (await db.query(
        `UPDATE app_service_notice AS n SET resolved_at=NOW(),resolved_by=$2 WHERE n.id=$1 RETURNING ${columns}`,
        [id, user.id],
      )).rows[0];
      await new StaffModel(db).audit(user.id, null, "service_notice.resolved", "app_service_notice", id, reason, before, after);
      await notify(db, await everyone(db), "service_restored", id, { reason });
      return after;
    });
    res.json({ data });
  });
  return router;
}
