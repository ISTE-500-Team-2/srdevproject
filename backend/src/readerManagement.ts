import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import {
  accessResources,
  assertReaderTarget,
  enrollmentId,
  ReaderRegistry,
  requireDeviceConfig,
} from "./readerRegistry.js";

export function readerManagement(
  pool: Pool,
  tz: string,
  registry: ReaderRegistry,
) {
  const routes = Router(),
    read = requirePermission(pool, "user", "read"),
    write = requirePermission(pool, "user_access", "update");
  routes.get("/admin/access/readers", read, async (_req, res) => {
    res.json({
      data: {
        configured: !!registry.config,
        timeZone: tz,
        readers: await registry.list(),
      },
    });
  });
  routes.get("/admin/access/resources", read, async (_req, res) => {
    res.json({ data: await accessResources(pool) });
  });
  routes.post("/admin/access/readers", write, requireCsrf, async (req, res) => {
    requireDeviceConfig(registry.config);
    await registry.ready();
    const id = textField(req.body.id, "Reader ID", 64),
      name = textField(req.body.name, "Reader name", 100);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id))
      throw new AppError(
        400,
        "INVALID_READER",
        "Use letters, numbers, hyphens or underscores for the reader ID.",
      );
    const kind = req.body.kind,
      resourceId = positiveId(req.body.resourceId),
      secret = randomBytes(32).toString("hex");
    const reason = textField(req.body.reason, "Reason", 500);
    const data = await transaction(pool, async (db) => {
      await assertReaderTarget(db, kind, resourceId);
      const after = (
        await db.query(
          `INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted)
        VALUES($1,$2,$3,$4,$5) RETURNING id,name,kind,resource_id AS "resourceId",enabled,revision`,
          [id, name, kind, resourceId, registry.encrypt(secret)],
        )
      ).rows[0];
      await new StaffModel(db, tz).audit(
        authState(res).user.id,
        null,
        "access.reader_created",
        "access_reader",
        0,
        reason,
        null,
        after,
      );
      return after;
    });
    // Shown only once on creation; list, edit and audit responses never contain it.
    res.status(201).json({ data: { ...data, secret } });
  });
  routes.patch(
    "/admin/access/readers/:id",
    write,
    requireCsrf,
    async (req, res) => {
      await registry.ready();
      const name = textField(req.body.name, "Reader name", 100),
        reason = textField(req.body.reason, "Reason", 500);
      if (typeof req.body.enabled !== "boolean")
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Choose whether the reader is enabled.",
        );
      const data = await transaction(pool, async (db) => {
        const before = (
          await db.query(
            "SELECT id,name,enabled,revision FROM app_access_reader WHERE id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (!before) throw new AppError(404, "NOT_FOUND", "Reader not found.");
        if (before.revision !== positiveId(req.body.expectedRevision))
          throw new AppError(
            409,
            "STALE_RECORD",
            "This reader changed. Refresh and try again.",
          );
        const after = (
          await db.query(
            `UPDATE app_access_reader SET name=$2,enabled=$3,revision=revision+1 WHERE id=$1 RETURNING id,name,enabled,revision`,
            [before.id, name, req.body.enabled],
          )
        ).rows[0];
        if (!after.enabled)
          await db.query(
            "UPDATE app_card_enrollment SET cancelled_at=NOW() WHERE reader_id=$1 AND completed_at IS NULL AND cancelled_at IS NULL",
            [before.id],
          );
        await new StaffModel(db, tz).audit(
          authState(res).user.id,
          null,
          "access.reader_updated",
          "access_reader",
          0,
          reason,
          before,
          after,
        );
        return after;
      });
      res.json({ data });
    },
  );
  routes.post(
    "/admin/access/enrollments",
    write,
    requireCsrf,
    async (req, res) => {
      requireDeviceConfig(registry.config);
      await registry.ready();
      const readerId = textField(req.body.readerId, "Reader", 64),
        purpose = req.body.purpose;
      if (!["assign", "lookup"].includes(purpose))
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Choose assign or look up a card.",
        );
      const userId = purpose === "assign" ? positiveId(req.body.userId) : null;
      const data = await transaction(pool, async (db) => {
        const reader = (
          await db.query(
            "SELECT id,enabled FROM app_access_reader WHERE id=$1 FOR UPDATE",
            [readerId],
          )
        ).rows[0];
        if (!reader?.enabled)
          throw new AppError(
            409,
            "READER_UNAVAILABLE",
            "Choose an enabled reader.",
          );
        if (
          userId &&
          !(
            await db.query('SELECT 1 FROM "user" WHERE userid=$1 FOR SHARE', [
              userId,
            ])
          ).rowCount
        )
          throw new AppError(404, "NOT_FOUND", "Member not found.");
        await db.query(
          `UPDATE app_card_enrollment SET cancelled_at=NOW() WHERE reader_id=$1 AND expires_at<=NOW()
        AND completed_at IS NULL AND cancelled_at IS NULL`,
          [readerId],
        );
        if (
          (
            await db.query(
              "SELECT id FROM app_card_enrollment WHERE reader_id=$1 AND completed_at IS NULL AND cancelled_at IS NULL",
              [readerId],
            )
          ).rowCount
        )
          throw new AppError(
            409,
            "READER_BUSY",
            "This reader is already waiting for a card confirmation. Finish or cancel that scan, or wait two minutes.",
          );
        return (
          await db.query(
            `INSERT INTO app_card_enrollment(id,reader_id,user_id,actor_id,purpose)
        VALUES($1,$2,$3,$4,$5) RETURNING id,reader_id AS "readerId",user_id AS "userId",purpose,expires_at AS "expiresAt",'waiting' AS status`,
            [randomUUID(), readerId, userId, authState(res).user.id, purpose],
          )
        ).rows[0];
      });
      res.status(201).json({ data });
    },
  );
  routes.get("/admin/access/enrollments/:id", write, async (req, res) => {
    const session = (
      await pool.query(
        `SELECT id,reader_id AS "readerId",user_id AS "userId",purpose,uid_last4 AS "last4",uid_hash,
      expires_at AS "expiresAt",CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN completed_at IS NOT NULL AND purpose='assign' THEN 'completed'
      WHEN expires_at<=NOW() THEN 'expired' WHEN captured_at IS NOT NULL THEN 'captured' ELSE 'waiting' END AS status
      FROM app_card_enrollment WHERE id=$1 AND actor_id=$2`,
        [enrollmentId(req.params.id), authState(res).user.id],
      )
    ).rows[0];
    if (!session) throw new AppError(404, "NOT_FOUND", "Card scan not found.");
    const { uid_hash, ...data } = session;
    const assignments =
      session.status === "captured"
        ? (
            await pool.query(
              `SELECT c.id,c.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      c.label,c.active,c.assigned_at AS "assignedAt" FROM app_access_card c JOIN "user" u ON u.userid=c.user_id
      WHERE c.uid_hash=$1 ORDER BY c.active DESC,c.id DESC LIMIT 20`,
              [uid_hash],
            )
          ).rows
        : [];
    res.json({ data: { ...data, assignments } });
  });
  routes.post(
    "/admin/access/enrollments/:id/cancel",
    write,
    requireCsrf,
    async (req, res) => {
      const result = await pool.query(
        `UPDATE app_card_enrollment SET cancelled_at=COALESCE(cancelled_at,NOW())
      WHERE id=$1 AND actor_id=$2 AND completed_at IS NULL RETURNING id`,
        [enrollmentId(req.params.id), authState(res).user.id],
      );
      res.json({ data: { cancelled: !!result.rowCount } });
    },
  );
  routes.get("/admin/access/events", read, async (req, res) => {
    const values: unknown[] = [],
      filters = ["e.is_tap"];
    if (req.query.readerId) {
      values.push(textField(req.query.readerId, "Reader", 64));
      filters.push(`e.reader_id=$${values.length}`);
    }
    if (req.query.userId) {
      values.push(positiveId(req.query.userId));
      filters.push(`e.user_id=$${values.length}`);
    }
    if (req.query.before) {
      values.push(positiveId(req.query.before));
      filters.push(`e.id<$${values.length}`);
    }
    const result = req.query.result;
    if (result === "allowed") filters.push("e.allowed");
    else if (result === "denied") filters.push("NOT e.allowed");
    else if (result === "unknown")
      filters.push("e.card_id IS NULL AND e.uid_hash IS NOT NULL");
    else if (result !== undefined && result !== "all")
      throw new AppError(400, "INVALID_INPUT", "Choose a tap result.");
    const rows = (
      await pool.query(
        `SELECT e.id,e.reader_id AS "readerId",COALESCE(r.name,e.reader_id) AS "readerName",
      e.user_id AS "userId",u.firstname || ' ' || u.lastname AS "memberName",e.uid_last4 AS "last4",e.allowed,e.reason,
      e.created_at AS "createdAt" FROM app_device_access_event e LEFT JOIN app_access_reader r ON r.id=e.reader_id
      LEFT JOIN "user" u ON u.userid=e.user_id WHERE ${filters.join(" AND ")} ORDER BY e.id DESC LIMIT 51`,
        values,
      )
    ).rows;
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextBefore: rows.length > 50 ? rows[49].id : null,
      },
    });
  });
  return routes;
}
