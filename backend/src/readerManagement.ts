// Staff reader configuration and diagnostics routes; the registry owns credential encryption and
// resource targeting. Adding, renaming, moving or turning on a reader is hardware configuration
// (CON-001) and needs `reader:update`, which only administrators hold. Staff keep card scans and
// may still turn a reader off, a safety action.

import { randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { requireStaffPermission } from "./middleware/permissions.js";
import { PermissionModel } from "./models/PermissionModel.js";
import { StaffModel } from "./models/StaffModel.js";
import { AccessCardRepository } from "./models/access/cards.js";
import { CardEnrollmentRepository } from "./models/access/enrollments.js";
import { AccessEventRepository, type TapResult } from "./models/access/events.js";
import { AccessReaderRepository } from "./models/access/readers.js";
import { assertManageable } from "./services/StaffService.js";
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
    read = requireStaffPermission(pool, "user", "read"),
    write = requireStaffPermission(pool, "user_access", "update"),
    configure = requireStaffPermission(pool, "reader", "update");
  routes.get("/admin/access/readers", read, async (_req, res) => {
    res.json({
      data: {
        configured: !!registry.config,
        // Lets the page show staff why add/turn-on controls are off instead of a failing button.
        canConfigure: await new PermissionModel(pool).allows(
          authState(res).user,
          "reader",
          "update",
        ),
        timeZone: tz,
        readers: await registry.list(),
      },
    });
  });
  routes.get("/admin/access/resources", read, async (_req, res) => {
    res.json({ data: await accessResources(pool) });
  });
  routes.post(
    "/admin/access/readers",
    configure,
    requireCsrf,
    async (req, res) => {
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
        const after = await new AccessReaderRepository(db).createReader(
          id,
          name,
          kind,
          resourceId,
          registry.encrypt(secret),
        );
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
    },
  );
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
      // A location is optional, so older clients that only rename or disable keep working.
      const move =
          req.body.kind !== undefined || req.body.resourceId !== undefined,
        kind = move ? req.body.kind : null,
        resourceId = move ? positiveId(req.body.resourceId) : null;
      const data = await transaction(pool, async (db) => {
        const readers = new AccessReaderRepository(db);
        const before = await readers.lockReader(req.params.id);
        if (!before) throw new AppError(404, "NOT_FOUND", "Reader not found.");
        if (before.revision !== positiveId(req.body.expectedRevision))
          throw new AppError(
            409,
            "STALE_RECORD",
            "This reader changed. Refresh and try again.",
          );
        // Without reader:update, the only change allowed is turning the reader off as it is.
        if (
          (req.body.enabled || move || name !== before.name) &&
          !(await new PermissionModel(db).allows(
            authState(res).user,
            "reader",
            "update",
          ))
        )
          throw new AppError(
            403,
            "PERMISSION_REQUIRED",
            "Only an admin can add or turn on readers, or change a reader's name or location. You can turn a reader off.",
          );
        if (
          req.body.enabled &&
          registry.config?.setupGateways?.length &&
          (await readers.unfinishedSetups(before.id))
        )
          throw new AppError(
            409,
            "SETUP_INCOMPLETE",
            "Finish guided setup before enabling this reader.",
          );
        if (move) await assertReaderTarget(db, kind, resourceId!);
        const after = await readers.updateReader(
          before.id,
          name,
          req.body.enabled,
          kind,
          resourceId,
        );
        if (!after.enabled)
          await new CardEnrollmentRepository(db).cancelOnReader(before.id);
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
        const readers = new AccessReaderRepository(db),
          enrollments = new CardEnrollmentRepository(db);
        const reader = await readers.lockForScan(readerId);
        if (!reader?.enabled)
          throw new AppError(
            409,
            "READER_UNAVAILABLE",
            "Choose an enabled reader.",
          );
        // A scan denies every request on its reader, lease renewals included, so starting
        // one mid-session would cut power to a running machine or relock an open door.
        // Readers renew once a second with leases of at most 5 seconds, so a grant decided
        // in the last 10 seconds that has not expired means someone is using it now.
        if (await readers.recentGrants(readerId))
          throw new AppError(
            409,
            "READER_IN_USE",
            "Someone is using this reader right now. Start the scan when they finish, or choose another reader.",
          );
        if (userId && !(await enrollments.lockMember(userId)))
          throw new AppError(404, "NOT_FOUND", "Member not found.");
        // Refuse before the scan, not after it: the assignment itself is refused for these accounts.
        if (userId) await assertManageable(db, authState(res).user, userId);
        await enrollments.expireStale(readerId);
        if (await enrollments.openOnReader(readerId))
          throw new AppError(
            409,
            "READER_BUSY",
            "This reader is already waiting for a card confirmation. Finish or cancel that scan, or wait two minutes.",
          );
        return await enrollments.create(
          randomUUID(),
          readerId,
          userId,
          authState(res).user.id,
          purpose,
        );
      });
      res.status(201).json({ data });
    },
  );
  routes.get("/admin/access/enrollments/:id", write, async (req, res) => {
    const session = await new CardEnrollmentRepository(pool).session(
      enrollmentId(req.params.id),
      authState(res).user.id,
    );
    if (!session) throw new AppError(404, "NOT_FOUND", "Card scan not found.");
    const { uid_hash, ...data } = session;
    const assignments =
      session.status === "captured"
        ? await new AccessCardRepository(pool).scanAssignments(uid_hash)
        : [];
    res.json({ data: { ...data, assignments } });
  });
  routes.post(
    "/admin/access/enrollments/:id/cancel",
    write,
    requireCsrf,
    async (req, res) => {
      const cancelled = await new CardEnrollmentRepository(pool).cancel(
        enrollmentId(req.params.id),
        authState(res).user.id,
      );
      res.json({ data: { cancelled: !!cancelled } });
    },
  );
  routes.get("/admin/access/events", read, async (req, res) => {
    const readerId = req.query.readerId
        ? textField(req.query.readerId, "Reader", 64)
        : undefined,
      userId = req.query.userId ? positiveId(req.query.userId) : undefined,
      before = req.query.before ? positiveId(req.query.before) : undefined;
    const result = req.query.result;
    if (
      result !== undefined &&
      result !== "allowed" &&
      result !== "denied" &&
      result !== "unknown" &&
      result !== "all"
    )
      throw new AppError(400, "INVALID_INPUT", "Choose a tap result.");
    const rows = await new AccessEventRepository(pool).taps({
      readerId,
      userId,
      before,
      result: result as TapResult | undefined,
    });
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextBefore: rows.length > 50 ? rows[49]!.id : null,
      },
    });
  });
  return routes;
}
