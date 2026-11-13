import type { Database } from "../../db.js";

export type PaymentFilters = { status?: string | null; from?: string | null; to?: string | null };
export type PaymentSummary = { count: number; collected: string; pendingCount: number; pending: string; refunded: string };
/** One payment as the payment editor sees it (locked for update). */
export interface PaymentRecord {
  id: number;
  userId: number | null;
  amount: string;
  // Nullable in the legacy schema; every application write sets it.
  status: string;
  method: string;
  reference: string;
  note: string;
  revision: number;
}
/** One row of the staff payment ledger. */
export interface PaymentListItem {
  id: number;
  userId: number | null;
  memberName: string | null;
  membershipId: number | null;
  dayPassId: number | null;
  amount: string;
  status: string;
  method: string;
  reference: string;
  revision: number;
  recordedAt: Date | null;
  updatedAt: Date;
  invoiceId: string | null;
  refundStatus: string | null;
  planName: string;
}

const paymentRecordColumns = `paymentid AS id,userid AS "userId",price::text AS amount,paymentstatus AS status,method,reference,note,revision`;
// $1 member, $2 status, $3/$4 recorded-at window (ISO instants); paymentdate is stored as UTC.
const PAYMENT_FILTER = `($1::int IS NULL OR p.userid=$1) AND ($2::text IS NULL OR p.paymentstatus=$2)
      AND ($3::timestamptz IS NULL OR p.paymentdate AT TIME ZONE 'UTC'>=$3) AND ($4::timestamptz IS NULL OR p.paymentdate AT TIME ZONE 'UTC'<$4)`;

/** Recorded payments and their ledger views. */
export class PaymentRepository {
  constructor(private db: Database) {}
  async createPayment(
    userId: number,
    membershipId: number | null,
    price: string,
    status: string,
    method: string,
    reference: string,
    reason: string,
    actorId: number,
  ): Promise<number> {
    return (
      await this.db.query<{ id: number }>(
        `INSERT INTO payment(userid,membershipid,price,paymentstatus,paymentdate,method,reference,note,recorded_by)
      VALUES($1,$2,$3,$4,NOW() AT TIME ZONE 'UTC',$5,$6,$7,$8) RETURNING paymentid AS id`,
        [
          userId,
          membershipId,
          price,
          status,
          method,
          reference,
          reason,
          actorId,
        ],
      )
    ).rows[0]!.id;
  }
  async linkPassPayment(passId: number, paymentId: number): Promise<void> {
    await this.db.query("UPDATE day_pass SET paymentid=$2 WHERE dayid=$1", [
      passId,
      paymentId,
    ]);
  }
  async payment(id: number): Promise<PaymentRecord | undefined> {
    return (
      await this.db.query<PaymentRecord>(
        `SELECT ${paymentRecordColumns} FROM payment WHERE paymentid=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  async updatePayment(
    id: number,
    status: string,
    method: string,
    reference: string,
    reason: string,
    revision: number,
  ): Promise<PaymentRecord | undefined> {
    return (
      await this.db.query<PaymentRecord>(
        `UPDATE payment SET paymentstatus=$2::text,method=$3,reference=$4,note=$5,revision=revision+1,updated_at=NOW(),
      price=CASE WHEN $2::text='waived' THEN 0 ELSE price END WHERE paymentid=$1 AND revision=$6
      RETURNING ${paymentRecordColumns}`,
        [id, status, method, reference, reason, revision],
      )
    ).rows[0];
  }
  async payments(userId: number | null, offset = 0, filters: PaymentFilters = {}): Promise<PaymentListItem[]> {
    return (
      await this.db.query<PaymentListItem>(
        `SELECT p.paymentid AS id,p.userid AS "userId",u.firstname || ' ' || u.lastname AS "memberName",
      p.membershipid AS "membershipId",d.dayid AS "dayPassId",p.price::text AS amount,p.paymentstatus AS status,p.method,p.reference,p.revision,
      p.paymentdate AT TIME ZONE 'UTC' AS "recordedAt",p.updated_at AS "updatedAt",
      invoice.id AS "invoiceId",invoice.refund_status AS "refundStatus",
      COALESCE(m.plan_snapshot->>'name',d.plan_snapshot->>'name',t.tiername,
        CASE WHEN booking.reservationid IS NOT NULL THEN 'Equipment: '||machine.name||
          CASE WHEN booking.status='cancelled' AND p.paymentstatus='paid' THEN ' (cancelled; refund due)' ELSE '' END END,
        CASE WHEN training.class_id IS NOT NULL THEN 'Training class: '||class.title||
          CASE WHEN (training.status='cancelled' OR class.status='cancelled') AND p.paymentstatus='paid'
            THEN ' (cancelled; refund due)' ELSE '' END END,
        CASE WHEN p.note LIKE 'Equipment booking:%' OR p.note LIKE 'Training class:%' THEN p.note END,'Legacy record') AS "planName"
      FROM payment p LEFT JOIN "user" u USING(userid) LEFT JOIN user_membership m USING(membershipid)
      LEFT JOIN membership_tiers t ON m.tierid=t.tierid LEFT JOIN LATERAL(SELECT * FROM day_pass WHERE paymentid=p.paymentid ORDER BY dayid LIMIT 1) d ON true
      LEFT JOIN reservation booking ON booking.payment_id=p.paymentid LEFT JOIN equipment machine ON machine.equipmentid=booking.equipmentid
      LEFT JOIN app_training_enrollment training ON training.payment_id=p.paymentid
      LEFT JOIN app_training_class class ON class.id=training.class_id
      LEFT JOIN LATERAL(SELECT id,refund_status FROM app_membership_invoice WHERE payment_id=p.paymentid ORDER BY period_start DESC LIMIT 1) invoice ON true
      WHERE ${PAYMENT_FILTER} ORDER BY p.paymentid DESC LIMIT 51 OFFSET $5`,
        [userId, filters.status ?? null, filters.from ?? null, filters.to ?? null, offset],
      )
    ).rows;
  }
  /** Totals for every payment matching the filters, not just the current page. */
  async paymentSummary(userId: number | null, filters: PaymentFilters = {}): Promise<PaymentSummary> {
    return (
      await this.db.query<PaymentSummary>(
        `SELECT COUNT(*)::int AS count,
      COALESCE(SUM(p.price) FILTER (WHERE p.paymentstatus='paid'),0)::text AS collected,
      COUNT(*) FILTER (WHERE p.paymentstatus='pending')::int AS "pendingCount",
      COALESCE(SUM(p.price) FILTER (WHERE p.paymentstatus='pending'),0)::text AS pending,
      COALESCE(SUM(p.price) FILTER (WHERE p.paymentstatus='refunded'),0)::text AS refunded
      FROM payment p WHERE ${PAYMENT_FILTER}`,
        [userId, filters.status ?? null, filters.from ?? null, filters.to ?? null],
      )
    ).rows[0]!;
  }
}
