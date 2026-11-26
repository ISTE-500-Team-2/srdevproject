// Combines staff announcements with reader-health alerts; notification history is retained when an
// incident is resolved.

import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, integerId, textField } from "./domain.js";
import { authState, requireCsrf, requireStaff } from "./middleware/auth.js";
import { requireAdmin } from "./middleware/permissions.js";
import { oneOf, optionalReasonField, pageOffset } from "./staffDomain.js";
import { page } from "./pagination.js";
import { StaffModel } from "./models/StaffModel.js";
import { enqueueNotifications } from "./notifications/store.js";
import { ServiceNoticeModel } from "./models/ServiceNoticeModel.js";

// Reader alerts reach a few staff and keep the usual five-minute target. An announcement to every
// account is a broadcast: it gets an hour, and the worker sends one person's mail, such as a reset
// link, ahead of it.
async function notify(db: Database, audience: number[], kind: "system_issue" | "service_restored", noticeId: number, payload: object,
  broadcast = false) {
  await enqueueNotifications(db, audience, {
    kind, dedupePrefix: `${kind}:${noticeId}:`,
    payload: { noticeId, ...payload, ...(broadcast ? { broadcast: true as const } : {}) },
    deadlineAt: broadcast ? new Date(Date.now() + 60 * 60_000) : undefined,
  });
}

/** Tells staff when an enabled reader goes silent and again when it returns. The
 * server can only report what it can observe: its own outage needs outside monitoring. */
export async function checkReaderHealth(pool: Pool) {
  await transaction(pool, async (db) => {
    const notices = new ServiceNoticeModel(db);
    await notices.lockHealthCheck();
    const opened = await notices.openSilentReaders();
    const closed = await notices.closeClearedReaders();
    // A reader that staff disabled or removed is not a recovery worth announcing.
    const restored = closed.filter((notice) => notice.online);
    if (!opened.length && !restored.length) return;
    const audience = await notices.staffAudience();
    if (opened.length)
      await notices.setRecipients(
        opened.map((notice) => notice.id),
        await notices.reachable(audience),
      );
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

const periods = { "7d": "7 days", "30d": "30 days", all: null } as const;

export function serviceNoticeRoutes(pool: Pool) {
  const router = Router();
  // Reaches every member's inbox, so only administrators can send or resolve one.
  const administrator = requireAdmin("Administrator permission is required.");
  /** Open notices first, then a page of past ones filtered by when they opened and where they came from. */
  router.get("/admin/service-notices", requireStaff, async (req, res) => {
    const period = periods[oneOf(req.query.period ?? "all", ["7d", "30d", "all"] as const, "period")];
    const source = req.query.source ? oneOf(req.query.source, ["reader", "staff"] as const, "source") : null;
    const offset = pageOffset(req.query.offset);
    const notices = new ServiceNoticeModel(pool);
    const [open, history] = await Promise.all([notices.open(), notices.history(period, source, offset)]);
    const total = history[0]?.total ?? (offset ? null : 0);
    res.json({
      data: {
        open,
        ...page(history.map(({ total: _total, ...row }) => row), offset),
        total,
      },
    });
  });
  /** How many people an announcement would reach right now. */
  router.get("/admin/service-notices/audience", requireStaff, async (_req, res) => {
    const notices = new ServiceNoticeModel(pool);
    res.json({ data: { recipients: await notices.reachable(await notices.everyone()) } });
  });
  router.post("/admin/service-notices", requireStaff, requireCsrf, administrator, async (req, res) => {
    const { user } = authState(res);
    const summary = textField(req.body.summary, "Summary", 500, 5),
      reason = optionalReasonField(req.body.reason, "Told members about a service problem");
    const data = await transaction(pool, async (db) => {
      const notices = new ServiceNoticeModel(db);
      const audience = await notices.everyone();
      const notice = await notices.openStaffNotice(summary, user.id, await notices.reachable(audience));
      await new StaffModel(db).audit(user.id, null, "service_notice.opened", "app_service_notice", notice.id, reason, null, notice);
      await notify(db, audience, "system_issue", notice.id, { reason: summary }, true);
      return notice;
    });
    res.status(201).json({ data });
  });
  router.post("/admin/service-notices/:id/resolve", requireStaff, requireCsrf, administrator, async (req, res) => {
    const { user } = authState(res);
    const id = integerId(req.params.id),
      message = textField(req.body.message, "What was fixed", 500),
      reason = optionalReasonField(req.body.reason, message.slice(0, 255));
    const data = await transaction(pool, async (db) => {
      const notices = new ServiceNoticeModel(db);
      const before = await notices.findForUpdate(id);
      if (!before) throw new AppError(404, "NOT_FOUND", "Service notice not found.");
      if (before.resolvedAt) throw new AppError(409, "ALREADY_RESOLVED", "This notice was already resolved.");
      if (before.source !== "staff")
        throw new AppError(409, "AUTOMATIC_NOTICE", "This notice clears itself when the reader reconnects.");
      const after = await notices.resolve(id, user.id, message);
      await new StaffModel(db).audit(user.id, null, "service_notice.resolved", "app_service_notice", id, reason, before, after);
      await notify(db, await notices.everyone(), "service_restored", id, { reason: message }, true);
      return after;
    });
    res.json({ data });
  });
  return router;
}
