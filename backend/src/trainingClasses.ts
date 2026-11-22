// Class scheduling, enrollment, attendance and credential issuance routes; booking capacity and
// training payments are coordinated in transactions.

import { MinorSupervision } from "./minorSupervision.js";
import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError, integerId, positiveId, textField } from "./domain.js";
import { authState, requireCsrf, requireStaff } from "./middleware/auth.js";
import { anySignedIn, requirePermission } from "./middleware/permissions.js";
import { StaffModel } from "./models/StaffModel.js";
import { EligibilityModel } from "./models/EligibilityModel.js";
import { ClassCatalogModel } from "./models/ClassCatalogModel.js";
import { TrainingClassModel } from "./models/TrainingClassModel.js";
import { ReservationModel } from "./models/ReservationModel.js";
import { cancelTrainingPayments, enrollTrainingPayment } from './trainingPricing.js';
import { classManagement } from './classManagement.js';
export function trainingClassRoutes(pool: Pool, tz: string) {
  const r = Router();
  r.use(classManagement(pool, tz));
  r.get('/classes/catalog',anySignedIn,async(_req,res)=>res.json({data:await new ClassCatalogModel(pool).list()}));
  r.get("/classes", anySignedIn, async (_req, res) => {
    const user = authState(res).user;
    res.json({
      data: await new TrainingClassModel(pool).listFor(user.id, tz, user.roles.some((x) => ["staff", "admin"].includes(x))),
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
        const classes = new TrainingClassModel(db);
        const roomId = positiveId(req.body.roomId),
          instructorId = positiveId(req.body.instructorId),
          certId = req.body.certificationId == null ? null : positiveId(req.body.certificationId),
          capacity = positiveId(req.body.capacity),
          title = textField(req.body.title, "Title", 100),
          reason = textField(req.body.reason, "Reason", 500);
        if (capacity>15) throw new AppError(400,'CAPACITY_LIMIT','Classes are limited to 15 participants.');
        const catalogId=req.body.catalogId == null ? null : positiveId(req.body.catalogId);
        const catalog=catalogId ? await new ClassCatalogModel(db).shareTemplate(catalogId) : null;
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
        // The lock makes classes scheduled at the same time for one instructor take turns. It is
        // taken before the room lock, the same user-then-room order as door access and bookings.
        if (!(await classes.lockActiveInstructor(instructorId)))
          throw new AppError(
            400,
            "INSTRUCTOR_REQUIRED",
            "Assign an active instructor.",
          );
        const room = await classes.lockRoom(roomId);
        if (!room || room.status !== "available")
          throw new AppError(409, "ROOM_UNAVAILABLE", "This room is not available for classes.");
        // A room without a seat count entered is limited only by the 15-person class cap.
        if (capacity > 15 || (room.capacity != null && capacity > room.capacity))
          throw new AppError(
            400,
            "CAPACITY_LIMIT",
            "Classes allow at most 15 people and cannot exceed the room's capacity.",
          );
        const course = certId ? await classes.currentCertification(certId) : null;
        if (certId && !course)
          throw new AppError(
            400,
            "CERTIFICATION_REQUIRED",
            "Choose a current certification.",
          );
        if (course && (ends.getTime()-starts.getTime())/60000 < course.training_minutes)
          throw new AppError(400, 'TRAINING_DURATION', `This certification requires at least ${course.training_minutes} minutes of training.`);
        if (await new ReservationModel(db, tz).roomOverlaps(roomId, starts, ends))
          throw new AppError(409, "RESERVATION_CONFLICT", "That room is already reserved for part of this time.");
        if (await classes.instructorBusy(instructorId, starts, ends))
          throw new AppError(409, "INSTRUCTOR_CONFLICT", "This instructor is already teaching another class at this time.");
        // The booking belongs to the class, not to the staff member scheduling it, so the
        // per-member room cooldown does not apply: classes can run back to back.
        const slot = await classes.bookRoom(user.id, roomId, starts, ends, reason);
        const after = await classes.create(
            [
              title,
              certId,
              instructorId,
              slot.reservationid,
              capacity,
              user.id,
              catalogId, description, catalog?.imagepath ?? null,
            ],
          );
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
  r.post("/classes/:id/enroll", anySignedIn, requireCsrf, async (req, res) => {
    const user = authState(res).user;
    const data = await transaction(pool, async (db) => {
      const classes = new TrainingClassModel(db);
      await classes.lockUser(user.id);
      const id = integerId(req.params.id, "Class"),
        c = await classes.lockForEnrollment(id);
      if (!c || c.status !== "scheduled" || c.starts <= new Date())
        throw new AppError(409, "CLASS_CLOSED", "Registration is closed.");
      if (user.status !== "active" || user.accessStatus !== "active")
        throw new AppError(403, "ACCESS_BLOCKED", "Your account is blocked.");
      // Checked over the class's own time: a day pass for the class day counts ahead of time,
      // and a membership that ends before the class does not.
      const e = await new EligibilityModel(db, tz).entitlement(
        user.id,
        c.starts,
        c.ends,
      );
      if (!e.membership && !e.dayPass)
        throw new AppError(
          403,
          "ENTITLEMENT_REQUIRED",
          "You need a membership or day pass that covers the class time.",
        );
      // Lock the member row before sponsor rows (the enrollment FK needs it anyway),
      // matching sponsor link/unlink order: user, then sponsor.
      await classes.shareUser(user.id);
      const sponsor=await new MinorSupervision(db,tz).requireLinkedSponsor(user.id);
      const before = await classes.enrollment(id, user.id);
      if (before && ["enrolled", "attended"].includes(before.status))
        return before;
      const count = await classes.seatsTaken(id);
      if (count >= Math.min(c.capacity, 15))
        throw new AppError(409, "CLASS_FULL", "This class is full.");
      const { fee, paymentId } = await enrollTrainingPayment(db, tz, user.id, c, before, req.body.expectedTrainingFeeCents);
      const after = await classes.enroll(id, user.id, fee, paymentId, sponsor?.id ?? null);
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
  r.post("/classes/:id/withdraw", anySignedIn, requireCsrf, async (req, res) => {
    const user = authState(res).user;
    await transaction(pool, async (db) => {
      const id = integerId(req.params.id, "Class");
      const classes = new TrainingClassModel(db);
      const c = await classes.lockForWithdrawal(id);
      const before = await classes.lockEnrollment(id, user.id);
      if (!before || before.status !== "enrolled")
        throw new AppError(
          409,
          "NOT_ENROLLED",
          "Only pending enrollment can be withdrawn.",
        );
      if (!c || c.status !== 'scheduled' || c.booking_status !== 'confirmed' || c.starts <= new Date())
        throw new AppError(409, 'CLASS_CLOSED', 'Withdraw before the class starts. Contact staff for changes.');
      await cancelTrainingPayments(db, id, user.id);
      const after = await classes.withdraw(id, user.id);
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
      // Seats, and names only where allowed (see TrainingClassModel.memberRoster).
      const user = authState(res).user,
        staff = user.roles.some((x) => ["staff", "admin"].includes(x));
      const roster = await new TrainingClassModel(pool).memberRoster(integerId(req.params.id, "Class"), user.id, staff, tz);
      if (!roster) throw new AppError(404, "CLASS_ROSTER_UNAVAILABLE", "The participant list is available for upcoming scheduled classes only.");
      res.set("Cache-Control", "no-store");
      res.json({ data: roster });
    },
  );
  r.get(
    "/classes/:id/roster",
    requirePermission(pool, "certification", "read"),
    async (req, res) => {
      const classes = new TrainingClassModel(pool);
      const user = authState(res).user,
        id = integerId(req.params.id, "Class"),
        c = await classes.instructorOf(id);
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
      res.json({ data: await classes.roster(id) });
    },
  );
  r.post(
    "/classes/:id/attendance",
    requirePermission(pool, "certification", "update"),
    requireCsrf,
    async (req, res) => {
      const user = authState(res).user;
      const data = await transaction(pool, async (db) => {
        const classes = new TrainingClassModel(db);
        const id = integerId(req.params.id, "Class"),
          userId = positiveId(req.body.userId),
          c = await classes.lockForAttendance(id);
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
        const before = await classes.lockEnrollment(id, userId);
        if (!before || before.status === "cancelled")
          throw new AppError(404, "NOT_FOUND", "Enrolled member not found.");
        const after = await classes.recordAttendance(id, userId, req.body.status);
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
        const classes = new TrainingClassModel(db);
        const id = integerId(req.params.id, "Class"),
          before = await classes.lock(id);
        if (!before) throw new AppError(404, "NOT_FOUND", "Class not found.");
        const booking = await classes.booking(before.reservation_id);
        // A class that has started may have run: its attendance and unpaid fees stand.
        if (before.status !== "scheduled" || booking?.status !== "confirmed" || booking.starts <= new Date())
          throw new AppError(
            409,
            "CLASS_CLOSED",
            "Only a scheduled class that hasn't started yet can be cancelled.",
          );
        if (before.revision !== positiveId(req.body.expectedRevision))
          throw new AppError(
            409,
            "STALE_RECORD",
            "Refresh class before cancelling.",
          );
        const reason = textField(req.body.reason, "Reason", 500);
        await cancelTrainingPayments(db, id);
        await classes.cancelBooking(before.reservation_id, reason);
        const after = await classes.cancel(id);
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
