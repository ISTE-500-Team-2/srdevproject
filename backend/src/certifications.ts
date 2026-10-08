import { Router } from "express";
import type { Pool } from "pg";
import { transaction, type Database } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf } from "./middleware/auth.js";
import { PermissionModel } from "./models/PermissionModel.js";
import { UserModel } from "./models/UserModel.js";
import { StaffModel } from "./models/StaffModel.js";
import { scheduleExpirationNotifications } from "./notifications/scheduler.js";

const definition = `c.certid AS id,c.name,c.description,c.validity_days AS "validityDays",c.revision,
 c.effectivedate AT TIME ZONE 'UTC' AS "effectiveAt",c.enddate AT TIME ZONE 'UTC' AS "endsAt",
 COALESCE((SELECT json_agg(e.equipmentid ORDER BY e.equipmentid) FROM equipment e WHERE e.certid=c.certid),'[]') AS "equipmentIds"`;
const record = `uc.usercertid AS id,uc.userid AS "userId",uc.certid AS "certificationId",c.name,uc.status,uc.revision,
 uc.renewaldate AT TIME ZONE 'UTC' AS "expiresAt",uc.trained_at AS "trainedAt",uc.approved_at AS "approvedAt",
 uc.approved_by AS "approvedBy",a.firstname||' '||a.lastname AS "instructorName",uc.training_source AS source,
 uc.verified_in_person AS "verifiedInPerson",uc.verification_reference AS "verificationReference",
 (uc.status='active' AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')
 AND (c.effectivedate IS NULL OR c.effectivedate<=NOW() AT TIME ZONE 'UTC')
 AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC')) AS valid`;
export function certificationRoutes(pool: Pool, timeZone: string) {
  const router = Router();
  async function actor(
    db: Database,
    id: number,
    action: string,
    kind: "catalog" | "approve" | "revoke" | "read",
  ) {
    await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [id]);
    const user = await new UserModel(db).findById(id);
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
  const tx = <T>(work: (db: Database) => Promise<T>) =>
    transaction(pool, async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('arbor-certification-writes'))",
      );
      return work(db);
    });
  router.get("/training/catalog", async (_req, res) => {
    await actor(pool, authState(res).user.id, "read", "read");
    res.json({
      data: (
        await pool.query(
          `SELECT ${definition} FROM certifications c ORDER BY c.name,c.certid`,
        )
      ).rows,
    });
  });
  router.post("/training/catalog", requireCsrf, async (req, res) => {
    const data = await tx(async (db) => {
      const user = await actor(db, authState(res).user.id, "create", "catalog");
      const name = textField(req.body.name, "Name", 100),
        description = textField(
          req.body.description ?? "",
          "Description",
          255,
          0,
        );
      const days = positiveId(req.body.validityDays, "Validity days");
      if (days > 3650)
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Validity must be 1–3650 days.",
        );
      const reason = textField(req.body.reason, "Approval/reference", 500);
      const equipmentIds = equipmentList(req.body.equipmentIds);
      const id = (
        await db.query(
          "SELECT COALESCE(MAX(certid),0)+1 AS id FROM certifications",
        )
      ).rows[0]!.id;
      await db.query(
        "INSERT INTO certifications(certid,name,description,effectivedate,validity_days) VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC',$4)",
        [id, name, description, days],
      );
      await linkEquipment(db, id, equipmentIds);
      const after = (
        await db.query(
          `SELECT ${definition} FROM certifications c WHERE certid=$1`,
          [id],
        )
      ).rows[0];
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
  router.patch("/training/catalog/:id", requireCsrf, async (req, res) => {
    const data = await tx(async (db) => {
      const user = await actor(db, authState(res).user.id, "update", "catalog");
      const id = positiveId(req.params.id);
      const before = (
        await db.query(
          `SELECT ${definition} FROM certifications c WHERE certid=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!before)
        throw new AppError(404, "NOT_FOUND", "Certification not found.");
      if (before.revision !== positiveId(req.body.expectedRevision, "Revision"))
        throw new AppError(
          409,
          "STALE_RECORD",
          "Refresh the certification before editing.",
        );
      const days = positiveId(req.body.validityDays, "Validity days");
      if (days > 3650)
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Validity must be 1–3650 days.",
        );
      const name = textField(req.body.name, "Name", 100),
        description = textField(
          req.body.description ?? "",
          "Description",
          255,
          0,
        ),
        reason = textField(req.body.reason, "Reason", 500);
      await db.query(
        "UPDATE certifications SET name=$2,description=$3,validity_days=$4,revision=revision+1 WHERE certid=$1",
        [id, name, description, days],
      );
      await linkEquipment(db, id, equipmentList(req.body.equipmentIds));
      const after = (
        await db.query(
          `SELECT ${definition} FROM certifications c WHERE certid=$1`,
          [id],
        )
      ).rows[0];
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
  router.get("/training/users/:userId", async (req, res) => {
    await actor(pool, authState(res).user.id, "read", "read");
    const userId = positiveId(req.params.userId);
    res.json({
      data: (
        await pool.query(
          `SELECT ${record} FROM user_certifications uc JOIN certifications c USING(certid) LEFT JOIN "user" a ON a.userid=uc.approved_by WHERE uc.userid=$1 ORDER BY c.name`,
          [userId],
        )
      ).rows,
    });
  });
  router.post(
    "/training/users/:userId/certifications/:id",
    requireCsrf,
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
        const target = await new UserModel(db).findById(userId);
        if (!target || target.status !== "active")
          throw new AppError(404, "NOT_FOUND", "Active member not found.");
        const cert = (
          await db.query(
            "SELECT *, effectivedate AT TIME ZONE 'UTC' AS effectivedate,enddate AT TIME ZONE 'UTC' AS enddate FROM certifications WHERE certid=$1 FOR SHARE",
            [id],
          )
        ).rows[0];
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
        if (!cert.validity_days)
          throw new AppError(
            409,
            "VALIDITY_NOT_CONFIGURED",
            "Staff must configure this certification’s approved validity period.",
          );
        if (req.body.verifiedInPerson !== true)
          throw new AppError(
            400,
            "IN_PERSON_REQUIRED",
            "Training must be verified in person.",
          );
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
        const before =
          (
            await db.query(
              "SELECT * FROM user_certifications WHERE userid=$1 AND certid=$2 FOR UPDATE",
              [userId, id],
            )
          ).rows[0] ?? null;
        if (before) await actor(db, user.id, "update", "approve");
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
        let expires = new Date(
          trainedAt.getTime() + cert.validity_days * 86400000,
        );
        if (cert.enddate)
          expires = new Date(
            Math.min(expires.getTime(), cert.enddate.getTime()),
          );
        if (expires <= new Date())
          throw new AppError(
            400,
            "TRAINING_EXPIRED",
            "This training is already expired. Record current completed training.",
          );
        const recordId =
          before?.usercertid ??
          (
            await db.query(
              "SELECT COALESCE(MAX(usercertid),0)+1 AS id FROM user_certifications",
            )
          ).rows[0]!.id;
        await db.query(
          `INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status,statusdesc,trained_at,approved_at,approved_by,verification_reference,training_source,verified_in_person)
    VALUES($1,$2,$3,$4::timestamptz AT TIME ZONE 'UTC','active',$5,$6,NOW(),$7,$8,$9,true)
    ON CONFLICT(userid,certid) DO UPDATE SET renewaldate=EXCLUDED.renewaldate,status='active',statusdesc=EXCLUDED.statusdesc,trained_at=EXCLUDED.trained_at,approved_at=NOW(),approved_by=EXCLUDED.approved_by,verification_reference=EXCLUDED.verification_reference,training_source=EXCLUDED.training_source,verified_in_person=true,revision=user_certifications.revision+1`,
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
          ],
        );
        const after = (
          await db.query(
            `SELECT ${record} FROM user_certifications uc JOIN certifications c USING(certid) LEFT JOIN "user" a ON a.userid=uc.approved_by WHERE uc.userid=$1 AND uc.certid=$2`,
            [userId, id],
          )
        ).rows[0];
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
        const before = (
          await db.query(
            "SELECT * FROM user_certifications WHERE userid=$1 AND certid=$2 FOR UPDATE",
            [userId, id],
          )
        ).rows[0];
        if (!before)
          throw new AppError(404, "NOT_FOUND", "Training record not found.");
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
        const after = (
          await db.query(
            "UPDATE user_certifications SET status='revoked',statusdesc=$3,revision=revision+1 WHERE userid=$1 AND certid=$2 RETURNING *",
            [userId, id, reason],
          )
        ).rows[0];
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
        return after;
      });
      res.json({ data });
    },
  );
  return router;
}
function equipmentList(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new AppError(400, "INVALID_INPUT", "Choose equipment IDs.");
  return [...new Set(value.map((v) => positiveId(v, "Equipment")))];
}
async function linkEquipment(db: Database, id: number, ids: number[]) {
  // Never clear existing associations implicitly or replace another required course.
  for (const equipmentId of ids) {
    const e = (
      await db.query(
        "SELECT certid FROM equipment WHERE equipmentid=$1 FOR UPDATE",
        [equipmentId],
      )
    ).rows[0];
    if (!e) throw new AppError(404, "NOT_FOUND", "Equipment not found.");
    if (e.certid != null && e.certid !== id)
      throw new AppError(
        409,
        "CERTIFICATION_LINK_EXISTS",
        "Equipment already requires a different certification. Change that association through an explicitly reviewed policy change.",
      );
    await db.query("UPDATE equipment SET certid=$2 WHERE equipmentid=$1", [
      equipmentId,
      id,
    ]);
  }
}
