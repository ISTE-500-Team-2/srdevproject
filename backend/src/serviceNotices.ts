import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { oneOf, optionalReasonField, pageOffset } from "./staffDomain.js";
import { page } from "./controllers/StaffController.js";
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
/** Of these accounts, how many will actually get the email: active and not opted out. */
const reachable = async (db: Database, audience: number[]) =>
  (await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "user" u LEFT JOIN app_notification_preferences p USING(userid)
    WHERE u.userid=ANY($1::int[]) AND u.status='active' AND COALESCE(p.enabled,true)`, [audience])).rows[0]?.count ?? 0;

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
    if (opened.length)
      await db.query("UPDATE app_service_notice SET recipients=$2 WHERE id=ANY($1::int[])", [
        opened.map((notice) => notice.id),
        await reachable(db, audience),
      ]);
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
const periods = { "7d": "7 days", "30d": "30 days", all: null } as const;

export function serviceNoticeRoutes(pool: Pool) {
  const router = Router();
  // Reaches every member's inbox, so only administrators can send one.
  const administrator = (res: Parameters<typeof authState>[0]) => {
    const { user } = authState(res);
    if (!user.roles.includes("admin"))
      throw new AppError(403, "ADMIN_REQUIRED", "Administrator permission is required.");
    return user;
  };
  /** Open notices first, then a page of past ones filtered by when they opened and where they came from. */
  router.get("/admin/service-notices", async (req, res) => {
    const period = periods[oneOf(req.query.period ?? "all", ["7d", "30d", "all"] as const, "period")];
    const source = req.query.source ? oneOf(req.query.source, ["reader", "staff"] as const, "source") : null;
    const offset = pageOffset(req.query.offset);
    const [open, history] = await Promise.all([
      pool.query(`SELECT ${detail} FROM ${detailFrom} WHERE n.resolved_at IS NULL ORDER BY n.opened_at DESC,n.id DESC`),
      pool.query(
        `SELECT ${detail},COUNT(*) OVER()::int AS total FROM ${detailFrom}
         WHERE n.resolved_at IS NOT NULL AND ($1::interval IS NULL OR n.opened_at>=NOW()-$1::interval)
           AND ($2::text IS NULL OR n.source=$2)
         ORDER BY n.opened_at DESC,n.id DESC LIMIT 51 OFFSET $3`,
        [period, source, offset],
      ),
    ]);
    const total = history.rows[0]?.total ?? (offset ? null : 0);
    res.json({
      data: {
        open: open.rows,
        ...page(history.rows.map(({ total: _total, ...row }) => row), offset),
        total,
      },
    });
  });
  /** How many people an announcement would reach right now. */
  router.get("/admin/service-notices/audience", async (_req, res) => {
    res.json({ data: { recipients: await reachable(pool, await everyone(pool)) } });
  });
  router.post("/admin/service-notices", requireCsrf, async (req, res) => {
    const user = administrator(res);
    const summary = textField(req.body.summary, "Summary", 500, 5),
      reason = optionalReasonField(req.body.reason, "Told members about a service problem");
    const data = await transaction(pool, async (db) => {
      const audience = await everyone(db);
      const notice = (await db.query(
        `INSERT INTO app_service_notice AS n(source,summary,opened_by,recipients) VALUES('staff',$1,$2,$3) RETURNING ${columns},n.recipients`,
        [summary, user.id, await reachable(db, audience)],
      )).rows[0];
      await new StaffModel(db).audit(user.id, null, "service_notice.opened", "app_service_notice", notice.id, reason, null, notice);
      await notify(db, audience, "system_issue", notice.id, { reason: summary });
      return notice;
    });
    res.status(201).json({ data });
  });
  router.post("/admin/service-notices/:id/resolve", requireCsrf, async (req, res) => {
    const user = administrator(res);
    const id = positiveId(req.params.id),
      message = textField(req.body.message, "What was fixed", 500),
      reason = optionalReasonField(req.body.reason, message.slice(0, 255));
    const data = await transaction(pool, async (db) => {
      const before = (await db.query(`SELECT ${columns},n.resolution FROM app_service_notice n WHERE n.id=$1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new AppError(404, "NOT_FOUND", "Service notice not found.");
      if (before.resolvedAt) throw new AppError(409, "ALREADY_RESOLVED", "This notice was already resolved.");
      if (before.source !== "staff")
        throw new AppError(409, "AUTOMATIC_NOTICE", "This notice clears itself when the reader reconnects.");
      const after = (await db.query(
        `UPDATE app_service_notice AS n SET resolved_at=NOW(),resolved_by=$2,resolution=$3 WHERE n.id=$1 RETURNING ${columns},n.resolution`,
        [id, user.id, message],
      )).rows[0];
      await new StaffModel(db).audit(user.id, null, "service_notice.resolved", "app_service_notice", id, reason, before, after);
      await notify(db, await everyone(db), "service_restored", id, { reason: message });
      return after;
    });
    res.json({ data });
  });
  return router;
}
