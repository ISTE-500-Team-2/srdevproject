import { MinorSupervision } from "./minorSupervision.js";
import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, integerId, positiveId, textField } from "./domain.js";
import { authState, requireCsrf, requireStaff } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import { EligibilityModel } from "./models/EligibilityModel.js";
import { cancelTrainingPayments, enrollTrainingPayment, trainingFeeCoveredSql } from './trainingPricing.js';
export function trainingClassRoutes(pool: Pool, tz: string) {
  const r = Router();
  r.get('/classes/catalog',async(_req,res)=>res.json({data:(await pool.query('SELECT id,title,description,capacity FROM app_class_catalog ORDER BY id')).rows}));
  r.get("/classes", async (_req, res) => {
    const user = authState(res).user;
    res.json({
      data: (
        await pool.query(
          `SELECT c.id,c.title,c.certification_id AS "certificationId",COALESCE(cert.name,'Creative workshop') AS "certificationName",c.instructor_id AS "instructorId",u.firstname||' '||u.lastname AS instructor,LEAST(c.capacity,15) AS capacity,c.description,c.catalog_id AS "catalogId",CASE WHEN v.status='confirmed' THEN c.status ELSE 'cancelled' END AS status,c.revision,
 cert.training_minutes AS "trainingMinutes",cert.training_fee_cents AS "trainingFeeCents",
 ${trainingFeeCoveredSql('$1', 'cert.certid')} AS "trainingFeeCovered",
 v.roomid AS "roomId",room.name AS "roomName",v.starttime AT TIME ZONE 'UTC' AS "startsAt",v.endtime AT TIME ZONE 'UTC' AS "endsAt",(SELECT COUNT(*)::int FROM app_training_enrollment e WHERE e.class_id=c.id AND e.status IN ('enrolled','attended')) AS enrolled,
 mine.status AS "myStatus",mine.training_fee_cents AS "myTrainingFeeCents",p.paymentstatus AS "myPaymentStatus"
 FROM app_training_class c LEFT JOIN certifications cert ON cert.certid=c.certification_id JOIN reservation v ON v.reservationid=c.reservation_id JOIN room USING(roomid) JOIN "user" u ON u.userid=c.instructor_id
 LEFT JOIN app_training_enrollment mine ON mine.class_id=c.id AND mine.user_id=$1
 LEFT JOIN payment p ON p.paymentid=mine.payment_id ORDER BY v.starttime DESC LIMIT 200`,
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
          certId = req.body.certificationId == null ? null : positiveId(req.body.certificationId),
          capacity = positiveId(req.body.capacity),
          title = textField(req.body.title, "Title", 100),
          reason = textField(req.body.reason, "Reason", 500);
        if (capacity>15) throw new AppError(400,'CAPACITY_LIMIT','Classes are limited to 15 participants.');
        const catalogId=req.body.catalogId == null ? null : positiveId(req.body.catalogId);
        const catalog=catalogId ? (await db.query('SELECT * FROM app_class_catalog WHERE id=$1 FOR SHARE',[catalogId])).rows[0] : null;
        if (catalogId && !catalog) throw new AppError(400,'INVALID_CLASS','Choose an existing class template.');
        if (!certId && !catalog) throw new AppError(400,'CLASS_TYPE_REQUIRED','Choose a workshop template or training certification.');
        const description=textField(req.body.description ?? catalog?.description ?? '', 'Description',4000,0);
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
        if (!room || room.status !== "available" || capacity > 15 || capacity > room.capacity)
          throw new AppError(
            400,
            "CAPACITY_LIMIT",
            "Classes allow at most 15 people and cannot exceed the room's capacity.",
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
        const course = certId ? (await db.query(`SELECT certid,training_minutes FROM certifications WHERE certid=$1
          AND (effectivedate IS NULL OR effectivedate<=now() AT TIME ZONE 'UTC')
          AND (enddate IS NULL OR enddate>=now() AT TIME ZONE 'UTC')`, [certId])).rows[0] : null;
        if (certId && !course)
          throw new AppError(
            400,
            "CERTIFICATION_REQUIRED",
            "Choose a current certification.",
          );
        if (course && (ends.getTime()-starts.getTime())/60000 < course.training_minutes)
          throw new AppError(400, 'TRAINING_DURATION', `This certification requires at least ${course.training_minutes} minutes of training.`);
        const slot = (
          await db.query(
            `INSERT INTO reservation(userid,roomid,location,starttime,endtime,status,statusdesc) VALUES($1,$2,'Instructor-led training',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed',$5) RETURNING reservationid`,
            [user.id, roomId, starts, ends, reason],
          )
        ).rows[0];
        const after = (
          await db.query(
            "INSERT INTO app_training_class(title,certification_id,instructor_id,reservation_id,capacity,created_by,catalog_id,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              title,
              certId,
              instructorId,
              slot.reservationid,
              capacity,
              user.id,
              catalogId, description,
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
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [user.id]);
      const id = integerId(req.params.id, "Class"),
        c = (
          await db.query(
            `SELECT c.*,rm.buildingid AS building_id,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id JOIN room rm ON rm.roomid=v.roomid WHERE c.id=$1 AND v.status='confirmed' FOR UPDATE OF c`,
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
      // Lock the member row before sponsor rows (the enrollment FK needs it anyway),
      // matching sponsor link/unlink order: user, then sponsor.
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',[user.id]);
      const sponsor=await new MinorSupervision(db,tz).requireSponsor(user.id,c.building_id);
      const before = (
        await db.query(
          "SELECT * FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2",
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
      if (count >= Math.min(c.capacity, 15))
        throw new AppError(409, "CLASS_FULL", "This class is full.");
      const { fee, paymentId } = await enrollTrainingPayment(db, tz, user.id, c, before, req.body.expectedTrainingFeeCents);
      const after = (
        await db.query(
          `INSERT INTO app_training_enrollment(class_id,user_id,training_fee_cents,payment_id,sponsor_id) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(class_id,user_id) DO UPDATE SET status='enrolled',training_fee_cents=EXCLUDED.training_fee_cents,payment_id=EXCLUDED.payment_id,sponsor_id=EXCLUDED.sponsor_id RETURNING *`,
          [id, user.id, fee, paymentId, sponsor?.id ?? null],
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
      const id = integerId(req.params.id, "Class");
      const c = (await db.query(
        `SELECT c.status,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts
         FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id
         WHERE c.id=$1 FOR UPDATE OF c`,
        [id],
      )).rows[0];
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
      if (!c || c.status !== 'scheduled' || c.booking_status !== 'confirmed' || c.starts <= new Date())
        throw new AppError(409, 'CLASS_CLOSED', 'Withdraw before the class starts. Contact staff for changes.');
      await cancelTrainingPayments(db, id, user.id);
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
    "/classes/:id/member-roster",
    requirePermission(pool, "user", "read", "own"),
    async (req, res) => {
      // Separate from the instructor roster: never select contact details,
      // account IDs or attendance history for the member response.
      const { rows } = await pool.query(
        // Enrollment caps legacy larger classes at 15 seats; show the same limit.
        `SELECT LEAST(c.capacity,15) AS capacity,COUNT(e.user_id)::int AS enrolled,
          GREATEST(LEAST(c.capacity,15)-COUNT(e.user_id)::int,0) AS "seatsAvailable",
          COALESCE(json_agg(json_build_object('name',u.firstname||' '||left(u.lastname,1)||'.')
            ORDER BY u.firstname,u.lastname,e.user_id) FILTER(WHERE e.user_id IS NOT NULL),'[]') AS items
         FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id
         LEFT JOIN app_training_enrollment e ON e.class_id=c.id AND e.status IN ('enrolled','attended')
         LEFT JOIN "user" u ON u.userid=e.user_id
         WHERE c.id=$1 AND c.status='scheduled' AND v.status='confirmed'
           AND v.starttime>NOW() AT TIME ZONE 'UTC'
         GROUP BY c.id,c.capacity`,
        [integerId(req.params.id, "Class")],
      );
      if (!rows[0]) throw new AppError(404, "CLASS_ROSTER_UNAVAILABLE", "The participant list is available for upcoming scheduled classes only.");
      res.set("Cache-Control", "no-store");
      res.json({ data: rows[0] });
    },
  );
  r.get(
    "/classes/:id/roster",
    requirePermission(pool, "certification", "read"),
    async (req, res) => {
      const user = authState(res).user,
        id = integerId(req.params.id, "Class"),
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
        const id = integerId(req.params.id, "Class"),
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
        const id = integerId(req.params.id, "Class"),
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
        await cancelTrainingPayments(db, id);
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
