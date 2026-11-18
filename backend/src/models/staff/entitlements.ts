import type { Database } from "../../db.js";
import type { Plan } from "./plans.js";

export type EntitlementKind = "membership" | "day_pass";
/** Plan as recorded on an entitlement; legacy memberships fall back to the live tier's name/price/benefits. */
export type PlanSnapshot = Pick<Plan, "name" | "price" | "benefits"> & Partial<Plan>;

export interface MembershipRecord {
  id: number;
  userId: number;
  planId: number | null;
  // Status columns are nullable in the legacy schema; every application write sets them.
  status: string;
  reason: string | null;
  revision: number;
  cancellationRequestedAt: Date | null;
  cardBilled: boolean;
  /** Card billing that will charge again: no stop has been confirmed by the payment provider. */
  autoRenews: boolean;
  /** The last day of card billing once someone asked to stop it. */
  renewalEndsAt: Date | null;
  /** A stop was asked for but the payment provider hasn't confirmed it, so billing may still renew. */
  renewalStopPending: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  plan: PlanSnapshot;
  effectiveStatus: string;
}
export interface DayPassRecord {
  id: number;
  userId: number;
  planId: number | null;
  status: string;
  reason: string | null;
  revision: number;
  validDate: string | null;
  paymentId: number | null;
  plan: PlanSnapshot | null;
  effectiveStatus: string;
}
/** The locked/updated state of a membership or day pass. */
export interface EntitlementState {
  id: number;
  userId: number | null;
  status: string;
  revision: number;
}
export interface MembershipWindow {
  endsAt: Date;
  overlap: boolean;
}

// Keep the original expiry for sessions created before the visit deadline was enforced.
const legacyPassCheckoutPayBy = (zone: string) =>
  `LEAST(created_at+INTERVAL '23 hours',GREATEST((valid_date+1)::timestamp AT TIME ZONE ${zone},created_at+INTERVAL '45 minutes'))`;

function entitlementTable(kind: EntitlementKind) {
  return kind === "membership"
    ? { table: "user_membership", key: "membershipid" }
    : { table: "day_pass", key: "dayid" };
}

/**
 * SQL that is true while an app_membership_billing row (alias `b`) will still charge again. A stop counts
 * only once the payment provider confirms it: the last day is saved before the provider is asked, and that
 * request can fail, leaving the subscription renewing.
 */
export const billingRenewsSql = `(b.status NOT IN ('canceled','incomplete_expired','expired') AND NOT b.cancel_at_period_end
  AND NOT (b.cancellation_effective_at IS NOT NULL AND b.cancellation_confirmed))`;

/** Memberships and day passes held by members. */
export class EntitlementRepository {
  constructor(
    private db: Database,
    private timeZone: string,
  ) {}
  async memberships(userId: number): Promise<MembershipRecord[]> {
    return (
      await this.db.query<MembershipRecord>(
        `SELECT m.membershipid AS id,m.userid AS "userId",m.tierid AS "planId",m.status,m.statusdesc AS reason,m.revision,m.cancellation_requested_at AS "cancellationRequestedAt",
      EXISTS(SELECT 1 FROM app_membership_invoice i WHERE i.membership_id=m.membershipid) AS "cardBilled",
      COALESCE(${billingRenewsSql},false) AS "autoRenews",b.cancellation_effective_at AS "renewalEndsAt",
      COALESCE(${billingRenewsSql} AND b.cancellation_effective_at IS NOT NULL,false) AS "renewalStopPending",
      m.startdate AT TIME ZONE 'UTC' AS "startsAt",m.end_date AT TIME ZONE 'UTC' AS "endsAt",
      COALESCE(m.plan_snapshot,jsonb_build_object('name',t.tiername,'price',t.tierprice::text,'benefits',t.benefits)) AS plan,
      CASE WHEN m.status<>'active' THEN m.status WHEN m.end_date<=NOW() AT TIME ZONE 'UTC' THEN 'expired'
        WHEN m.startdate>NOW() AT TIME ZONE 'UTC' THEN 'scheduled' ELSE 'active' END AS "effectiveStatus"
      FROM user_membership m LEFT JOIN membership_tiers t USING(tierid)
      LEFT JOIN LATERAL (SELECT b.status,b.cancellation_effective_at,b.cancellation_confirmed,b.cancel_at_period_end FROM app_membership_invoice i
        JOIN app_membership_billing b ON b.id=i.billing_id WHERE i.membership_id=m.membershipid LIMIT 1) b ON true
      WHERE m.userid=$1 ORDER BY m.startdate DESC,m.membershipid DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  async passes(userId: number): Promise<DayPassRecord[]> {
    return (
      await this.db.query<DayPassRecord>(
        `SELECT d.dayid AS id,d.userid AS "userId",d.tierid AS "planId",d.status,d.statusdesc AS reason,d.revision,
      to_char(d.validdate,'YYYY-MM-DD') AS "validDate",d.paymentid AS "paymentId",d.plan_snapshot AS plan,
      CASE WHEN d.status<>'active' THEN d.status WHEN d.validdate::date<(NOW() AT TIME ZONE $2)::date THEN 'expired'
        WHEN d.validdate::date>(NOW() AT TIME ZONE $2)::date THEN 'scheduled' ELSE 'active' END AS "effectiveStatus"
      FROM day_pass d WHERE d.userid=$1 ORDER BY d.validdate DESC,d.dayid DESC LIMIT 100`,
        [userId, this.timeZone],
      )
    ).rows;
  }
  async entitlement(kind: EntitlementKind, id: number): Promise<EntitlementState | undefined> {
    const { table, key } = entitlementTable(kind);
    return (
      await this.db.query<EntitlementState>(
        `SELECT ${key} AS id,userid AS "userId",status,revision FROM ${table} WHERE ${key}=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  async membershipWindow(userId: number, startsAt: string, months: number): Promise<MembershipWindow> {
    return (
      await this.db.query<MembershipWindow>(
        // Months are added on the facility's wall clock, so a plan ends on the same local date
        // and time it started even when the UTC date differs or a DST change falls in between.
        `WITH span AS (SELECT $2::timestamptz AT TIME ZONE 'UTC' AS a,
      ((($2::timestamptz AT TIME ZONE $4)+make_interval(months=>$3::int)) AT TIME ZONE $4) AT TIME ZONE 'UTC' AS b)
      SELECT b AT TIME ZONE 'UTC' AS "endsAt",EXISTS(SELECT 1 FROM user_membership,span WHERE userid=$1 AND status IN('active','suspended')
      AND startdate<span.b AND end_date>span.a) AS overlap FROM span`,
        [userId, startsAt, months, this.timeZone],
      )
    ).rows[0]!;
  }
  /** When a new card session stops taking payment, capped at the end of the visit date. */
  async newPassCheckoutPayBy(date: string, start: Date): Promise<Date> {
    return (
      await this.db.query<{ payBy: Date }>(
        `SELECT LEAST($2::timestamptz+INTERVAL '23 hours',($1::date+1)::timestamp AT TIME ZONE $3) AS "payBy"`,
        [date, start, this.timeZone],
      )
    ).rows[0]!.payBy;
  }
  /** Why online checkout blocks a separate desk payment for this date. */
  async passCheckoutBlock(userId: number, date: string): Promise<"review" | "processing" | "open" | undefined> {
    return (
      await this.db.query<{ reason: "review" | "processing" | "open" }>(
        `SELECT CASE WHEN refund_needs_review THEN 'review' WHEN payment_id IS NOT NULL THEN 'processing' ELSE 'open' END AS reason
      FROM app_pass_checkout WHERE userid=$1 AND valid_date=$2::date AND status='pending'
      AND checkout_id IS NOT NULL AND (
        payment_id IS NOT NULL OR now()<COALESCE(checkout_expires_at,CASE WHEN checkout_has_expiry THEN ${legacyPassCheckoutPayBy("$3")}
          ELSE created_at+INTERVAL '24 hours' END)
      )`,
        [userId, date, this.timeZone],
      )
    ).rows[0]?.reason;
  }
  async passExists(userId: number, date: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          `SELECT dayid FROM day_pass WHERE userid=$1 AND validdate::date=$2::date AND status IN('active','suspended')`,
          [userId, date],
        )
      ).rows.length > 0
    );
  }
  async createMembership(
    userId: number,
    plan: Plan,
    startsAt: string,
    endsAt: Date,
    actorId: number,
    reason: string,
  ): Promise<number> {
    return (
      await this.db.query<{ id: number }>(
        `INSERT INTO user_membership(userid,tierid,startdate,end_date,status,statusdesc,plan_snapshot,issued_by)
      VALUES($1,$2,$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','active',$5,$6,$7)
      RETURNING membershipid AS id`,
        [
          userId,
          plan.id,
          startsAt,
          endsAt,
          reason,
          JSON.stringify(plan),
          actorId,
        ],
      )
    ).rows[0]!.id;
  }
  async createPass(
    userId: number,
    plan: Plan,
    date: string,
    actorId: number,
    reason: string,
  ): Promise<number> {
    return (
      await this.db.query<{ id: number }>(
        `INSERT INTO day_pass(userid,tierid,validdate,purchasedate,status,statusdesc,plan_snapshot,issued_by)
      VALUES($1,$2,$3::date,NOW() AT TIME ZONE 'UTC','active',$4,$5,$6) RETURNING dayid AS id`,
        [userId, plan.id, date, reason, JSON.stringify(plan), actorId],
      )
    ).rows[0]!.id;
  }
  async changeEntitlement(
    kind: EntitlementKind,
    id: number,
    status: string,
    reason: string,
    revision: number,
  ): Promise<EntitlementState | undefined> {
    const { table, key } = entitlementTable(kind);
    return (
      await this.db.query<EntitlementState>(
        `UPDATE ${table} SET status=$2,statusdesc=$3,revision=revision+1 WHERE ${key}=$1 AND revision=$4 RETURNING ${key} AS id,userid AS "userId",status,revision`,
        [id, status, reason, revision],
      )
    ).rows[0];
  }
}
