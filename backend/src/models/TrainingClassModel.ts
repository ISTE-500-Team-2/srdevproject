// Scheduled class sessions, their room bookings and member enrollment. Callers pass the pool or
// their transaction client, and call these in the order their locks must be taken.

import type { Database } from "../db.js";
import { entitlementSql } from "./EligibilityModel.js";
import { trainingFeeCoveredSql } from "../trainingPricing.js";

// Untyped rows, as where these queries used to run (a pool client); callers check what they read.
type Row = any;

export class TrainingClassModel {
  constructor(private db: Database) {}

  /** The latest 200 sessions as one member sees them; `staff` also shows pending attendance counts. */
  async listFor(userId: number, tz: string, staff: boolean) {
    // Registration checks the member's membership or day pass over the class's own time.
    const covered = entitlementSql("$1", "(v.starttime AT TIME ZONE 'UTC')", "(v.endtime AT TIME ZONE 'UTC')", "$2");
    return (
      await this.db.query<Row>(
        `SELECT c.id,c.title,c.certification_id AS "certificationId",COALESCE(cert.name,'Creative workshop') AS "certificationName",c.instructor_id AS "instructorId",u.firstname||' '||u.lastname AS instructor,LEAST(c.capacity,15) AS capacity,c.description,c.catalog_id AS "catalogId",CASE WHEN v.status='confirmed' THEN c.status ELSE 'cancelled' END AS status,c.revision,c.imagepath AS image,
 cert.training_minutes AS "trainingMinutes",cert.training_fee_cents AS "trainingFeeCents",
 ${trainingFeeCoveredSql('$1', 'cert.certid')} AS "trainingFeeCovered",
 v.roomid AS "roomId",room.name AS "roomName",v.starttime AT TIME ZONE 'UTC' AS "startsAt",v.endtime AT TIME ZONE 'UTC' AS "endsAt",(SELECT COUNT(*)::int FROM app_training_enrollment e WHERE e.class_id=c.id AND e.status IN ('enrolled','attended')) AS enrolled,
 mine.status AS "myStatus",mine.training_fee_cents AS "myTrainingFeeCents",p.paymentstatus AS "myPaymentStatus",
 CASE WHEN c.status='scheduled' AND v.status='confirmed' AND v.starttime>NOW() AT TIME ZONE 'UTC'
   THEN ${covered.membership} OR ${covered.dayPass} END AS "myEntitled",
 -- Registrations still awaiting attendance, for the people who can open the roster.
 CASE WHEN $3::boolean OR c.instructor_id=$1 THEN (SELECT COUNT(*)::int FROM app_training_enrollment e
   WHERE e.class_id=c.id AND e.status='enrolled') END AS "pendingAttendance"
 FROM app_training_class c LEFT JOIN certifications cert ON cert.certid=c.certification_id JOIN reservation v ON v.reservationid=c.reservation_id JOIN room USING(roomid) JOIN "user" u ON u.userid=c.instructor_id
 LEFT JOIN app_training_enrollment mine ON mine.class_id=c.id AND mine.user_id=$1
 LEFT JOIN payment p ON p.paymentid=mine.payment_id ORDER BY v.starttime DESC LIMIT 200`,
        [userId, tz, staff],
      )
    ).rows;
  }

  /**
   * Locks an active instructor's row; false when the account is not one. Classes scheduled at the
   * same time for one instructor take turns. Taken before the room lock: the same user-then-room
   * order as door access and bookings.
   */
  async lockActiveInstructor(instructorId: number) {
    return !!(
      await this.db.query<Row>(
        `SELECT u.userid FROM "user" u JOIN user_role ur USING(userid) JOIN role role USING(roleid) WHERE u.userid=$1 AND role.role='instructor' AND u.status='active' AND u.accessstatus='active' FOR NO KEY UPDATE OF u`,
        [instructorId],
      )
    ).rowCount;
  }

  async lockRoom(roomId: number) {
    return (
      await this.db.query<Row>(
        "SELECT capacity,status FROM room WHERE roomid=$1 FOR UPDATE",
        [roomId],
      )
    ).rows[0];
  }

  /** The certification, when it is in effect now. */
  async currentCertification(certId: number) {
    return (await this.db.query<Row>(`SELECT certid,training_minutes FROM certifications WHERE certid=$1
          AND (effectivedate IS NULL OR effectivedate<=now() AT TIME ZONE 'UTC')
          AND (enddate IS NULL OR enddate>=now() AT TIME ZONE 'UTC')`, [certId])).rows[0];
  }

  async instructorBusy(instructorId: number, starts: Date, ends: Date) {
    return !!(
      await this.db.query<Row>(
        `SELECT 1 FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id
               WHERE c.instructor_id=$1 AND c.status='scheduled' AND v.status='confirmed'
                 AND v.starttime < $3::timestamptz AT TIME ZONE 'UTC' AND v.endtime > $2::timestamptz AT TIME ZONE 'UTC' LIMIT 1`,
        [instructorId, starts, ends],
      )
    ).rowCount;
  }

  /**
   * The class's room booking. It belongs to the class, not to the staff member scheduling it, so
   * the per-member room cooldown does not apply: classes can run back to back.
   */
  async bookRoom(userId: number, roomId: number, starts: Date, ends: Date, reason: string) {
    return (
      await this.db.query<Row>(
        `INSERT INTO reservation(userid,roomid,location,starttime,endtime,status,statusdesc,cooldown_enforced) VALUES($1,$2,'Instructor-led training',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed',$5,false) RETURNING reservationid`,
        [userId, roomId, starts, ends, reason],
      )
    ).rows[0];
  }

  async create(values: unknown[]) {
    return (
      await this.db.query<Row>(
        "INSERT INTO app_training_class(title,certification_id,instructor_id,reservation_id,capacity,created_by,catalog_id,description,imagepath) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        values,
      )
    ).rows[0];
  }

  async lockUser(userId: number) {
    await this.db.query<Row>('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [userId]);
  }

  async shareUser(userId: number) {
    await this.db.query<Row>('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',[userId]);
  }

  /** A confirmed session with its building and times, locked for enrollment. */
  async lockForEnrollment(id: number) {
    return (
      await this.db.query<Row>(
        `SELECT c.*,rm.buildingid AS building_id,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts,v.endtime AT TIME ZONE 'UTC' AS ends FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id JOIN room rm ON rm.roomid=v.roomid WHERE c.id=$1 AND v.status='confirmed' FOR UPDATE OF c`,
        [id],
      )
    ).rows[0];
  }

  async enrollment(id: number, userId: number) {
    return (
      await this.db.query<Row>(
        "SELECT * FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2",
        [id, userId],
      )
    ).rows[0];
  }

  async lockEnrollment(id: number, userId: number) {
    return (
      await this.db.query<Row>(
        "SELECT * FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2 FOR UPDATE",
        [id, userId],
      )
    ).rows[0];
  }

  async seatsTaken(id: number) {
    return Number(
      (
        await this.db.query<Row>(
          "SELECT COUNT(*) FROM app_training_enrollment WHERE class_id=$1 AND status IN ('enrolled','attended')",
          [id],
        )
      ).rows[0].count,
    );
  }

  async enroll(id: number, userId: number, fee: unknown, paymentId: unknown, sponsorId: number | null) {
    return (
      await this.db.query<Row>(
        `INSERT INTO app_training_enrollment(class_id,user_id,training_fee_cents,payment_id,sponsor_id) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(class_id,user_id) DO UPDATE SET status='enrolled',training_fee_cents=EXCLUDED.training_fee_cents,payment_id=EXCLUDED.payment_id,sponsor_id=EXCLUDED.sponsor_id RETURNING *`,
        [id, userId, fee, paymentId, sponsorId],
      )
    ).rows[0];
  }

  async lockForWithdrawal(id: number) {
    return (await this.db.query<Row>(
      `SELECT c.status,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts
         FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id
         WHERE c.id=$1 FOR UPDATE OF c`,
      [id],
    )).rows[0];
  }

  async withdraw(id: number, userId: number) {
    return (
      await this.db.query<Row>(
        "UPDATE app_training_enrollment SET status='cancelled' WHERE class_id=$1 AND user_id=$2 RETURNING *",
        [id, userId],
      )
    ).rows[0];
  }

  /**
   * Seats and, where allowed, first names for an upcoming class; undefined when the class is not
   * upcoming and scheduled. Separate from the instructor roster: never selects contact details,
   * account IDs or attendance history. Seats are public to members. Names are shown only to people
   * registered for this class (plus its instructor and staff), and a classmate under 18 is never
   * named to other members. Birth date is optional on older accounts, so a classmate without one
   * on file may be a minor: hidden too.
   */
  async memberRoster(id: number, userId: number, staff: boolean, tz: string) {
    const { rows } = await this.db.query<Row>(
      `WITH class AS (
           -- Enrollment caps legacy larger classes at 15 seats; show the same limit.
           SELECT c.id,LEAST(c.capacity,15) AS capacity,($3::boolean OR c.instructor_id=$2) AS privileged
           FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id
           WHERE c.id=$1 AND c.status='scheduled' AND v.status='confirmed'
             AND v.starttime>NOW() AT TIME ZONE 'UTC'),
         people AS (
           SELECT e.user_id,u.firstname,u.lastname,
             (e.user_id<>$2 AND NOT class.privileged AND (u.dob IS NULL
               OR u.dob::date>((NOW() AT TIME ZONE $4)::date-INTERVAL '18 years')::date)) AS hidden
           FROM class JOIN app_training_enrollment e ON e.class_id=class.id AND e.status IN ('enrolled','attended')
           JOIN "user" u ON u.userid=e.user_id),
         access AS (
           SELECT class.privileged OR EXISTS(SELECT 1 FROM people WHERE user_id=$2) AS visible FROM class)
         SELECT class.capacity,(SELECT COUNT(*)::int FROM people) AS enrolled,
           GREATEST(class.capacity-(SELECT COUNT(*)::int FROM people),0) AS "seatsAvailable",
           access.visible AS "namesVisible",
           CASE WHEN access.visible THEN COALESCE((SELECT json_agg(json_build_object('name',
             CASE WHEN p.hidden THEN 'Name hidden' ELSE p.firstname||' '||left(p.lastname,1)||'.' END)
             ORDER BY p.hidden,p.firstname,p.lastname,p.user_id) FROM people p),'[]'::json)
           ELSE '[]'::json END AS items
         FROM class CROSS JOIN access`,
      [id, userId, staff, tz],
    );
    return rows[0];
  }

  async instructorOf(id: number) {
    return (
      await this.db.query<Row>(
        "SELECT instructor_id FROM app_training_class WHERE id=$1",
        [id],
      )
    ).rows[0];
  }

  /** The instructor roster: contact details and enrollment status. */
  async roster(id: number) {
    return (
      await this.db.query<Row>(
        `SELECT e.user_id AS "userId",u.firstname||' '||u.lastname AS name,u.email,e.status FROM app_training_enrollment e JOIN "user" u ON u.userid=e.user_id WHERE e.class_id=$1 ORDER BY u.lastname,u.firstname`,
        [id],
      )
    ).rows;
  }

  async lockForAttendance(id: number) {
    return (
      await this.db.query<Row>(
        `SELECT c.*,v.status AS booking_status,v.starttime AT TIME ZONE 'UTC' AS starts FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id WHERE c.id=$1 FOR UPDATE OF c`,
        [id],
      )
    ).rows[0];
  }

  async recordAttendance(id: number, userId: number, status: unknown) {
    return (
      await this.db.query<Row>(
        "UPDATE app_training_enrollment SET status=$3 WHERE class_id=$1 AND user_id=$2 RETURNING *",
        [id, userId, status],
      )
    ).rows[0];
  }

  async lock(id: number) {
    return (
      await this.db.query<Row>(
        "SELECT * FROM app_training_class WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
  }

  async booking(reservationId: number) {
    return (
      await this.db.query<Row>(
        "SELECT status,starttime AT TIME ZONE 'UTC' AS starts FROM reservation WHERE reservationid=$1",
        [reservationId],
      )
    ).rows[0];
  }

  async cancelBooking(reservationId: number, reason: string) {
    await this.db.query<Row>(
      "UPDATE reservation SET status='cancelled',revision=revision+1,statusdesc=$2 WHERE reservationid=$1",
      [reservationId, reason],
    );
  }

  async cancel(id: number) {
    return (
      await this.db.query<Row>(
        "UPDATE app_training_class SET status='cancelled',revision=revision+1 WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
  }
}
