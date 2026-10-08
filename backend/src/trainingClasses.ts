import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, positiveId, textField } from "./domain.js";
import { authState, requireCsrf, requireStaff } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import { EligibilityModel } from "./models/EligibilityModel.js";
export function trainingClassRoutes(pool: Pool, tz: string) {
  const r = Router();
  r.get("/classes", async (_req, res) => {
    const user = authState(res).user;
    res.json({
      data: (
        await pool.query(
          `SELECT c.id,c.title,c.certification_id AS "certificationId",cert.name AS "certificationName",c.instructor_id AS "instructorId",u.firstname||' '||u.lastname AS instructor,c.capacity,CASE WHEN v.status='confirmed' THEN c.status ELSE 'cancelled' END AS status,c.revision,
 v.roomid AS "roomId",room.name AS "roomName",v.starttime AT TIME ZONE 'UTC' AS "startsAt",v.endtime AT TIME ZONE 'UTC' AS "endsAt",(SELECT COUNT(*)::int FROM app_training_enrollment e WHERE e.class_id=c.id AND e.status IN ('enrolled','attended')) AS enrolled,
 (SELECT status FROM app_training_enrollment WHERE class_id=c.id AND user_id=$1) AS "myStatus"
 FROM app_training_class c JOIN certifications cert ON cert.certid=c.certification_id JOIN reservation v ON v.reservationid=c.reservation_id JOIN room USING(roomid) JOIN "user" u ON u.userid=c.instructor_id ORDER BY v.starttime DESC LIMIT 200`,
          [user.id],
        )
      ).rows,
    });
  });
  r.post(
    "/classes",
    requireStaff,
    requirePermission(pool, "certification", "create"),
    requireCsrf,
    async (req, res) => {
      const user = authState(res).user;
      const data = await transaction(pool, async (db) => {
        const roomId = positiveId(req.body.roomId),
          instructorId = positiveId(req.body.instructorId),
          certId = positiveId(req.body.certificationId),
          capacity = positiveId(req.body.capacity),
          title = textField(req.body.title, "Title", 100),
          reason = textField(req.body.reason, "Reason", 500);
        const starts = new Date(req.body.startsAt),
          ends = new Date(req.body.endsAt);
        if (
          !Number.isFinite(starts.getTime()) ||
          !Number.isFinite(ends.getTime()) ||
          starts <= new Date() ||
          ends <= starts ||
          ends.getTime() - starts.getTime() > 8 * 3600000
        )
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Schedule a future class of up to eight hours.",
          );
        const room = (
          await db.query(
            "SELECT capacity,status FROM room WHERE roomid=$1 FOR UPDATE",
            [roomId],
          )
        ).rows[0];
        if (!room || room.status !== "available" || capacity > room.capacity)
          throw new AppError(
            400,
            "CAPACITY_LIMIT",
            "Choose an available room within its capacity.",
          );
        if (
          !(
            await db.query(
              `SELECT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role role USING(roleid) WHERE u.userid=$1 AND role.role='instructor' AND u.status='active' AND u.accessstatus='active'`,
              [instructorId],
            )
          ).rowCount
        )
          throw new AppError(
            400,
            "INSTRUCTOR_REQUIRED",
            "Assign an active instructor.",
          );
        if (
          !(
            await db.query(
              "SELECT certid FROM certifications WHERE certid=$1 AND validity_days IS NOT NULL",
              [certId],
            )
          ).rowCount
        )
          throw new AppError(
            400,
            "CERTIFICATION_REQUIRED",
            "Configure the course validity first.",
          );
        const slot = (
          await db.query(
            `INSERT INTO reservation(userid,roomid,location,starttime,endtime,status,statusdesc) VALUES($1,$2,'Instructor-led training',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed',$5) RETURNING reservationid`,
            [user.id, roomId, starts, ends, reason],
          )
        ).rows[0];
        const after = (
          await db.query(
            "INSERT INTO app_training_class(title,certification_id,instructor_id,reservation_id,capacity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              title,
              certId,
              instructorId,
              slot.reservationid,
              capacity,
              user.id,
            ],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          user.id,
          null,
          "class.created",
          "training_class",
          after.id,
          reason,
          null,
          after,
        );
        return after;
      });
      res.status(201).json({ data });
    },
  );
  r.post("/classes/:id/enroll", requireCsrf, async (req, res) => {
    const user = authState(res).user;
    const data = await transaction(pool, async (db) => {
      const id = positiveId(req.params.id),
        c = (
          await db.query(
            `SELECT c.*,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id WHERE c.id=$1 AND v.status='confirmed' FOR UPDATE OF c`,
            [id],
          )
        ).rows[0];
      if (!c || c.status !== "scheduled" || c.starts <= new Date())
        throw new AppError(409, "CLASS_CLOSED", "Registration is closed.");
      if (user.status !== "active" || user.accessStatus !== "active")
        throw new AppError(403, "ACCESS_BLOCKED", "Your account is blocked.");
      const e = await new EligibilityModel(db, tz).entitlement(
        user.id,
        new Date(),
      );
      if (!e.membership && !e.dayPass)
        throw new AppError(
          403,
          "ENTITLEMENT_REQUIRED",
          "Active membership or day pass required.",
        );
      const before = (
        await db.query(
          "SELECT status FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2",
          [id, user.id],
        )
      ).rows[0];
      if (before && ["enrolled", "attended"].includes(before.status))
        return before;
      const count = Number(
        (
          await db.query(
            "SELECT COUNT(*) FROM app_training_enrollment WHERE class_id=$1 AND status IN ('enrolled','attended')",
            [id],
          )
        ).rows[0].count,
      );
      if (count >= c.capacity)
        throw new AppError(409, "CLASS_FULL", "This class is full.");
      const after = (
        await db.query(
          "INSERT INTO app_training_enrollment(class_id,user_id) VALUES($1,$2) ON CONFLICT(class_id,user_id) DO UPDATE SET status='enrolled' RETURNING *",
          [id, user.id],
        )
      ).rows[0];
      await new StaffModel(db, tz).audit(
        user.id,
        user.id,
        "class.enrolled",
        "training_class",
        id,
        "Member registered",
        before ?? null,
        after,
      );
      return after;
    });
    res.json({ data });
  });
  r.post("/classes/:id/withdraw", requireCsrf, async (req, res) => {
    const user = authState(res).user;
    await transaction(pool, async (db) => {
      const id = positiveId(req.params.id);
      await db.query(
        "SELECT id FROM app_training_class WHERE id=$1 FOR UPDATE",
        [id],
      );
      const before = (
        await db.query(
          "SELECT * FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2 FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!before || before.status !== "enrolled")
        throw new AppError(
          409,
          "NOT_ENROLLED",
          "Only pending enrollment can be withdrawn.",
        );
      const after = (
        await db.query(
          "UPDATE app_training_enrollment SET status='cancelled' WHERE class_id=$1 AND user_id=$2 RETURNING *",
          [id, user.id],
        )
      ).rows[0];
      await new StaffModel(db, tz).audit(
        user.id,
        user.id,
        "class.withdrawn",
        "training_class",
        id,
        "Member withdrew",
        before,
        after,
      );
    });
    res.json({ data: { status: "cancelled" } });
  });
  r.get(
    "/classes/:id/roster",
    requirePermission(pool, "certification", "read"),
    async (req, res) => {
      const user = authState(res).user,
        id = positiveId(req.params.id),
        c = (
          await pool.query(
            "SELECT instructor_id FROM app_training_class WHERE id=$1",
            [id],
          )
        ).rows[0];
      if (!c) throw new AppError(404, "NOT_FOUND", "Class not found.");
      if (
        !user.roles.some((x) => ["staff", "admin"].includes(x)) &&
        c.instructor_id !== user.id
      )
        throw new AppError(
          403,
          "CLASS_INSTRUCTOR_REQUIRED",
          "Only the assigned instructor can view this roster.",
        );
      res.json({
        data: (
          await pool.query(
            `SELECT e.user_id AS "userId",u.firstname||' '||u.lastname AS name,u.email,e.status FROM app_training_enrollment e JOIN "user" u ON u.userid=e.user_id WHERE e.class_id=$1 ORDER BY u.lastname,u.firstname`,
            [id],
          )
        ).rows,
      });
    },
  );
  r.post(
    "/classes/:id/attendance",
    requirePermission(pool, "certification", "update"),
    requireCsrf,
    async (req, res) => {
      const user = authState(res).user;
      const data = await transaction(pool, async (db) => {
        const id = positiveId(req.params.id),
          userId = positiveId(req.body.userId),
          c = (
            await db.query(
              `SELECT c.*,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id WHERE c.id=$1 FOR UPDATE OF c`,
              [id],
            )
          ).rows[0];
        if (
          !c ||
          c.status !== "scheduled" ||
          c.booking_status !== "confirmed" ||
          c.starts > new Date()
        )
          throw new AppError(
            409,
            "CLASS_NOT_STARTED",
            "Record actual attendance after the class starts.",
          );
        if (c.instructor_id !== user.id && !user.roles.includes("admin"))
          throw new AppError(
            403,
            "CLASS_INSTRUCTOR_REQUIRED",
            "Only the assigned instructor can verify attendance.",
          );
        if (!["attended", "no_show"].includes(req.body.status))
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Choose attended or no show.",
          );
        const before = (
          await db.query(
            "SELECT * FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2 FOR UPDATE",
            [id, userId],
          )
        ).rows[0];
        if (!before || before.status === "cancelled")
          throw new AppError(404, "NOT_FOUND", "Enrolled member not found.");
        const after = (
          await db.query(
            "UPDATE app_training_enrollment SET status=$3 WHERE class_id=$1 AND user_id=$2 RETURNING *",
            [id, userId, req.body.status],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          user.id,
          userId,
          "class.attendance",
          "training_class",
          id,
          textField(req.body.reason, "Verification", 500),
          before,
          after,
        );
        return after;
      });
      res.json({ data });
    },
  );
  r.post(
    "/classes/:id/cancel",
    requireStaff,
    requirePermission(pool, "certification", "update"),
    requireCsrf,
    async (req, res) => {
      const data = await transaction(pool, async (db) => {
        const id = positiveId(req.params.id),
          before = (
            await db.query(
              "SELECT * FROM app_training_class WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
        if (!before) throw new AppError(404, "NOT_FOUND", "Class not found.");
        if (before.revision !== positiveId(req.body.expectedRevision))
          throw new AppError(
            409,
            "STALE_RECORD",
            "Refresh class before cancelling.",
          );
        const reason = textField(req.body.reason, "Reason", 500);
        await db.query(
          "UPDATE reservation SET status='cancelled',revision=revision+1,statusdesc=$2 WHERE reservationid=$1",
          [before.reservation_id, reason],
        );
        const after = (
          await db.query(
            "UPDATE app_training_class SET status='cancelled',revision=revision+1 WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
        await new StaffModel(db, tz).audit(
          authState(res).user.id,
          null,
          "class.cancelled",
          "training_class",
          id,
          reason,
          before,
          after,
        );
        return after;
      });
      res.json({ data });
    },
  );
  return r;
}
