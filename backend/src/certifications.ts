// Training credential administration and member eligibility routes; certification revisions tie
// class completion to the requirement taught.

import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { accessGuard } from "./middleware/accessGuards.js";
import { CertificationModel } from "./models/CertificationModel.js";
import { PermissionModel } from "./models/PermissionModel.js";
import { UserModel } from "./models/UserModel.js";
import { StaffModel } from "./models/StaffModel.js";
import { scheduleExpirationNotifications } from "./notifications/scheduler.js";
import { queueCertificationRevoked } from "./notifications/certificationNotices.js";
import { annualValidity } from "./annualValidity.js";

export function certificationRoutes(pool: Pool, timeZone: string) {
  const router = Router();
  async function actor(
    db: Database,
    id: number,
    action: string,
    kind: "catalog" | "approve" | "revoke" | "read",
  ) {
    await new CertificationModel(db).shareUser(id);
    const user = await new UserModel(db, timeZone).findById(id);
    if (!user || user.status !== "active" || user.accessStatus !== "active")
      throw new AppError(
        403,
        "ACCESS_BLOCKED",
        "Your account cannot manage training.",
      );
    const allowed =
      kind === "approve"
        ? ["instructor", "admin"]
        : kind === "catalog" || kind === "revoke"
          ? ["staff", "admin"]
          : ["staff", "admin", "instructor"];
    if (
      !user.roles.some((r) => allowed.includes(r)) ||
      !(await new PermissionModel(db).allows(user, "certification", action))
    )
      throw new AppError(
        403,
        "PERMISSION_REQUIRED",
        "Authorized training-management permission is required.",
      );
    return user;
  }
  // Declared on each route. Writes check again inside their transaction, under the user-row lock,
  // so a role or grant removed meanwhile still stops them.
  const trainer = (action: string, kind: "catalog" | "approve" | "revoke" | "read") =>
    accessGuard(`training ${kind}: certification:${action}`, async (_req, res, next) => {
      await actor(pool, authState(res).user.id, action, kind);
      next();
    });
  const tx = <T>(work: (db: Database) => Promise<T>) =>
    transaction(pool, async (db) => {
      await new CertificationModel(db).lockWrites();
      return work(db);
    });
  router.get("/training/catalog", trainer("read", "read"), async (_req, res) => {
    res.json({ data: await new CertificationModel(pool).catalog() });
  });
  // The catalog cards' counts (see CertificationModel.holderCounts).
  router.get("/training/catalog/holders", trainer("read", "catalog"), async (_req, res) => {
    const rows = await new CertificationModel(pool).holderCounts();
    res.json({ data: rows });
  });
  // Instructors need a narrow identity lookup, not access to the admin user API.
  router.get("/training/members", trainer("read", "read"), async (req, res) => {
    const search = textField(req.query.search ?? "", "Member search", 100, 2);
    const instructorsOnly = req.query.role === "instructor";
    const rows = await new CertificationModel(pool).searchMembers(search, instructorsOnly);
    res.json({ data: { items: rows.slice(0, 25), hasMore: rows.length > 25 } });
  });
  router.post("/training/catalog", requireCsrf, trainer("create", "catalog"), async (req, res) => {
    const data = await tx(async (db) => {
      const user = await actor(db, authState(res).user.id, "create", "catalog");
      const name = textField(req.body.name, "Name", 100),
        description = textField(
          req.body.description ?? "",
          "Description",
          255,
          0,
        );
      const days = annualValidity(req.body.validityDays, "Certifications");
      const reason = textField(req.body.reason, "Approval/reference", 500);
      const pricing = trainingPricing(req.body);
      const equipmentIds = equipmentList(req.body.equipmentIds);
      const certifications = new CertificationModel(db);
      const id = await certifications.nextId();
      await certifications.create(id, name, description, days, pricing.fee, pricing.minutes);
      await linkEquipment(db, id, equipmentIds);
      const after = await certifications.definition(id);
      await new StaffModel(db, timeZone).audit(
        user.id,
        null,
        "certification.created",
        "certification",
        id,
        reason,
        null,
        after,
      );
      return after;
    });
    res.status(201).json({ data });
  });
  router.patch("/training/catalog/:id", requireCsrf, trainer("update", "catalog"), async (req, res) => {
    const data = await tx(async (db) => {
      const user = await actor(db, authState(res).user.id, "update", "catalog");
      const id = positiveId(req.params.id);
      const certifications = new CertificationModel(db);
      const before = await certifications.lockDefinition(id);
      if (!before)
        throw new AppError(404, "NOT_FOUND", "Certification not found.");
      if (before.revision !== positiveId(req.body.expectedRevision, "Revision"))
        throw new AppError(
          409,
          "STALE_RECORD",
          "Refresh the certification before editing.",
        );
      const days = annualValidity(req.body.validityDays, "Certifications");
      const name = textField(req.body.name, "Name", 100),
        description = textField(
          req.body.description ?? "",
          "Description",
          255,
          0,
        ),
        reason = textField(req.body.reason, "Reason", 500);
      const pricing = trainingPricing(req.body, before);
      await certifications.update(id, name, description, days, pricing.fee, pricing.minutes);
      await certifications.backfillExpiry(id);
      await linkEquipment(db, id, equipmentList(req.body.equipmentIds));
      const after = await certifications.definition(id);
      await new StaffModel(db, timeZone).audit(
        user.id,
        null,
        "certification.updated",
        "certification",
        id,
        reason,
        before,
        after,
      );
      return after;
    });
    res.json({ data });
  });
  router.get("/training/users/:userId", trainer("read", "read"), async (req, res) => {
    const userId = positiveId(req.params.userId);
    res.json({ data: await new CertificationModel(pool).memberRecords(userId) });
  });
  router.post(
    "/training/users/:userId/certifications/:id",
    requireCsrf,
    trainer("create", "approve"),
    async (req, res) => {
      const data = await tx(async (db) => {
        const user = await actor(
          db,
          authState(res).user.id,
          "create",
          "approve",
        );
        const userId = positiveId(req.params.userId),
          id = positiveId(req.params.id);
        if (user.id === userId)
          throw new AppError(
            403,
            "SELF_CERTIFICATION_FORBIDDEN",
            "Another authorized instructor must verify your training.",
          );
        const target = await new UserModel(db, timeZone).findById(userId);
        if (!target || target.status !== "active")
          throw new AppError(404, "NOT_FOUND", "Active member not found.");
        const certifications = new CertificationModel(db);
        const cert = await certifications.shareCertification(id);
        if (!cert)
          throw new AppError(404, "NOT_FOUND", "Certification not found.");
        if (
          (cert.effectivedate && new Date(cert.effectivedate) > new Date()) ||
          (cert.enddate && new Date(cert.enddate) < new Date())
        )
          throw new AppError(
            409,
            "CERTIFICATION_INACTIVE",
            "This certification is not currently effective.",
          );
        if (req.body.verifiedInPerson !== true)
          throw new AppError(
            400,
            "IN_PERSON_REQUIRED",
            "Training must be verified in person.",
          );
        const completedMinutes = req.body.trainingMinutes ?? cert.training_minutes;
        if (!Number.isSafeInteger(completedMinutes) || completedMinutes < cert.training_minutes || completedMinutes > 480)
          throw new AppError(400, 'TRAINING_DURATION', `Verify at least ${cert.training_minutes} minutes of completed training.`);
        if (!["equipment", "external"].includes(req.body.source))
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Select equipment or external training.",
          );
        if (
          typeof req.body.trainedAt !== "string" ||
          !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(req.body.trainedAt)
        )
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Use a training timestamp with a timezone.",
          );
        const trainedAt = new Date(req.body.trainedAt);
        if (!Number.isFinite(trainedAt.getTime()) || trainedAt > new Date())
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Use the actual completed training date, not a future date.",
          );
        const reference = textField(
            req.body.verificationReference,
            "Training verification reference",
            500,
          ),
          reason = textField(req.body.reason, "Reason", 500);
        const before = await certifications.lockTraining(userId, id);
        if (before) await actor(db, user.id, "update", "approve");
        if (before?.revoked_at && trainedAt <= new Date(before.revoked_at))
          throw new AppError(
            409,
            "RETRAINING_REQUIRED",
            "Record newly completed, in-person verified training after the access revocation.",
          );
        if (
          before &&
          before.revision !== positiveId(req.body.expectedRevision, "Revision")
        )
          throw new AppError(
            409,
            "STALE_RECORD",
            "Refresh the training record before renewing.",
          );
        if (!before && req.body.expectedRevision != null)
          throw new AppError(
            409,
            "STALE_RECORD",
            "Training record changed. Refresh before saving.",
          );
        let expires: Date | null = cert.validity_days
          ? new Date(trainedAt.getTime() + cert.validity_days * 86400000) : null;
        if (cert.enddate)
          expires = new Date(
            Math.min(expires?.getTime() ?? Infinity, cert.enddate.getTime()),
          );
        if (expires && expires <= new Date())
          throw new AppError(
            400,
            "TRAINING_EXPIRED",
            "This training is already expired. Record current completed training.",
          );
        const recordId =
          before?.usercertid ??
          (await certifications.nextTrainingId());
        await certifications.approve(
          [
            recordId,
            userId,
            id,
            expires,
            reason,
            trainedAt,
            user.id,
            reference,
            req.body.source,
            completedMinutes,
          ],
        );
        const after = await certifications.memberRecord(userId, id);
        await new StaffModel(db, timeZone).audit(
          user.id,
          userId,
          before ? "training.renewed" : "training.approved",
          "user_certification",
          recordId,
          reason,
          before,
          after,
        );
        await scheduleExpirationNotifications(db);
        return after;
      });
      res.status(201).json({ data });
    },
  );
  router.post(
    "/training/users/:userId/certifications/:id/revoke",
    requireCsrf,
    trainer("update", "revoke"),
    async (req, res) => {
      const data = await tx(async (db) => {
        const user = await actor(
          db,
          authState(res).user.id,
          "update",
          "revoke",
        );
        const userId = positiveId(req.params.userId),
          id = positiveId(req.params.id);
        // Whether the record was letting the member in: active and not past its renewal date.
        const certifications = new CertificationModel(db);
        const found = await certifications.lockTrainingForRevoke(userId, id);
        if (!found)
          throw new AppError(404, "NOT_FOUND", "Training record not found.");
        const { app_granting: granting, ...before } = found;
        if (
          before.revision !== positiveId(req.body.expectedRevision, "Revision")
        )
          throw new AppError(
            409,
            "STALE_RECORD",
            "Refresh the record before revoking.",
          );
        const reason = textField(
          req.body.reason,
          "Incident/retraining reason",
          500,
        );
        const after = await certifications.revoke(userId, id, reason);
        await new StaffModel(db, timeZone).audit(
          user.id,
          userId,
          "training.revoked",
          "user_certification",
          before.usercertid,
          reason,
          before,
          after,
        );
        // Only a certification that was in force is news to the member. Revoking a pending,
        // expired or already revoked record changes only the staff note.
        if (granting)
          await queueCertificationRevoked(db, { userid: userId, certid: id, usercertid: before.usercertid, revision: after!.revision });
        return after;
      });
      res.json({ data });
    },
  );
  return router;
}
function trainingPricing(body: Record<string, unknown>, before?: Record<string, unknown>) {
  const fee = body.trainingFeeCents === undefined ? (before ? before.trainingFeeCents : 0) : body.trainingFeeCents;
  const minutes = body.trainingMinutes === undefined ? before?.trainingMinutes ?? 60 : body.trainingMinutes;
  if (fee !== null && (!Number.isSafeInteger(fee) || (fee as number) < 0 || (fee as number) > 10000000))
    throw new AppError(400, 'INVALID_INPUT', 'The training fee must be a whole number of cents from 0 to 10000000.');
  if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 480)
    throw new AppError(400, 'INVALID_INPUT', 'Training duration must be 1–480 whole minutes.');
  return { fee: fee as number | null, minutes: minutes as number };
}
function equipmentList(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new AppError(400, "INVALID_INPUT", "Choose equipment IDs.");
  return [...new Set(value.map((v) => positiveId(v, "Equipment")))];
}
async function linkEquipment(db: Database, id: number, ids: number[]) {
  // An ended course can't be newly required: no one could book the equipment. Existing links stay.
  const certifications = new CertificationModel(db);
  const ended = await certifications.hasEnded(id);
  // Never clear existing associations implicitly or replace another required course.
  for (const equipmentId of ids) {
    const e = await certifications.lockEquipment(equipmentId);
    if (!e) throw new AppError(404, "NOT_FOUND", "Equipment not found.");
    if (e.certid != null && e.certid !== id)
      throw new AppError(
        409,
        "CERTIFICATION_LINK_EXISTS",
        "Equipment already requires a different certification. Change that association through an explicitly reviewed policy change.",
      );
    if (ended && e.certid !== id)
      throw new AppError(
        400,
        "INVALID_INPUT",
        "This certification has ended, so no one could book equipment that newly required it. Link equipment to a certification that is in effect.",
      );
    await certifications.requireForEquipment(equipmentId, id);
  }
}
