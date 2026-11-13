import { AppError } from '../domain.js';
import type { Database } from '../db.js';
import type { EquipmentPrice } from '../equipmentPricing.js';

export const RESERVATION_COOLDOWN_MINUTES = 15;

const selection = `r.reservationid AS id,r.userid AS "userId",r.equipmentid AS "equipmentId",r.roomid AS "roomId",
 COALESCE(e.name,room.name) AS "equipmentName",CASE WHEN r.roomid IS NULL THEN 'equipment' ELSE 'room' END AS "resourceType",
 r.starttime AT TIME ZONE 'UTC' AS "startTime",r.endtime AT TIME ZONE 'UTC' AS "endTime",r.location,r.status,
 (SELECT c.amount_cents FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid) AS "amountCents",
 COALESCE((SELECT c.status FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid),
   (SELECT paymentstatus FROM payment WHERE paymentid=r.payment_id)) AS "paymentStatus",
 (SELECT c.payer_id FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid) AS "payerId",
 (SELECT c.hold_until FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid) AS "holdUntil",
 r.revision,r.price_snapshot AS "priceSnapshot",
 COALESCE((SELECT c.payment_id FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid),r.payment_id) AS "paymentId",
 u.firstname || ' ' || u.lastname AS "memberName",u.email AS "memberEmail"`;
const joins = `LEFT JOIN equipment e USING (equipmentid) LEFT JOIN room ON room.roomid=r.roomid JOIN "user" u ON u.userid=r.userid`;

/** One row of `selection`. Grandfathered rows may hold neither resource, so the name can be null. */
export interface ReservationRecord {
  id: number;
  userId: number;
  equipmentId: number | null;
  roomId: number | null;
  equipmentName: string | null;
  resourceType: 'equipment' | 'room';
  startTime: Date;
  endTime: Date;
  location: string;
  status: string | null;
  amountCents: number | null;
  paymentStatus: string | null;
  payerId: number | null;
  holdUntil: Date | null;
  revision: number;
  priceSnapshot: EquipmentPrice | null;
  paymentId: number | null;
  memberName: string;
  memberEmail: string;
}

/** Exactly one bookable resource, as migration 010 requires of every enforced reservation. */
export type ReservationResource =
  | { equipmentId: number; roomId?: never }
  | { roomId: number; equipmentId?: never };

/** The member, resource and window a create or staff update writes. */
export type ReservationWrite = ReservationResource & {
  userId: number;
  waiverId: number | null;
  location: string;
  start: Date;
  end: Date;
};

export class ReservationModel {
  constructor(
    private db: Database,
    private timeZone = 'America/New_York',
  ) {}
  async listForUser(userId: number): Promise<ReservationRecord[]> {
    return (
      await this.db.query<ReservationRecord>(
        `SELECT ${selection} FROM reservation r ${joins} WHERE r.userid=$1 OR EXISTS(SELECT 1 FROM app_equipment_checkout c WHERE c.reservation_id=r.reservationid AND c.payer_id=$1) ORDER BY r.starttime DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  /**
   * Staff reservation list, newest first. `when` narrows to reservations that have not
   * ended (soonest first) or have ended; `search` matches member name or email and the
   * equipment or room name. Cancelled reservations are left out only when asked.
   */
  async listAll(filters: {
    date?: string;
    userId?: number | null;
    equipmentId?: number | null;
    offset?: number;
    when?: 'upcoming' | 'past' | null;
    search?: string | null;
    includeCancelled?: boolean;
  }): Promise<ReservationRecord[]> {
    const date = filters.date?.trim() || null;
    const search = filters.search?.trim()
      ? `%${filters.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      : null;
    return (
      await this.db.query<ReservationRecord>(
        `SELECT ${selection} FROM reservation r ${joins}
        WHERE ($1::date IS NULL OR (
            r.starttime >= (($1::date::timestamp AT TIME ZONE $5) AT TIME ZONE 'UTC')
            AND r.starttime < ((($1::date + 1)::timestamp AT TIME ZONE $5) AT TIME ZONE 'UTC')
          ))
          AND ($2::int IS NULL OR r.userid=$2)
          AND ($3::int IS NULL OR r.equipmentid=$3)
          AND ($6::text IS NULL
            OR ($6='upcoming' AND r.endtime > clock_timestamp() AT TIME ZONE 'UTC')
            OR ($6='past' AND r.endtime <= clock_timestamp() AT TIME ZONE 'UTC'))
          AND ($7::text IS NULL OR u.firstname || ' ' || u.lastname ILIKE $7 OR u.email ILIKE $7
            OR COALESCE(e.name,room.name) ILIKE $7)
          AND ($8::boolean OR r.status <> 'cancelled')
        ORDER BY CASE WHEN $6='upcoming' THEN r.starttime END ASC,
          r.starttime DESC,r.reservationid DESC LIMIT 51 OFFSET $4`,
        [
          date,
          filters.userId ?? null,
          filters.equipmentId ?? null,
          filters.offset ?? 0,
          this.timeZone,
          filters.when ?? null,
          search,
          filters.includeCancelled ?? true,
        ],
      )
    ).rows;
  }
  async upcomingEquipment(equipmentId: number, offset: number): Promise<(ReservationRecord & { isClass: boolean })[]> {
    return (await this.db.query<ReservationRecord & { isClass: boolean }>(`SELECT ${selection},
      EXISTS(SELECT 1 FROM app_training_class c WHERE c.reservation_id=r.reservationid) AS "isClass"
      FROM reservation r ${joins} WHERE r.equipmentid=$1 AND r.status IN ('confirmed','pending')
      AND r.endtime > clock_timestamp() AT TIME ZONE 'UTC'
      ORDER BY r.starttime,r.reservationid LIMIT 51 OFFSET $2`, [equipmentId, offset])).rows;
  }
  async find(id: number, lock = false): Promise<ReservationRecord | null> {
    return (
      await this.db.query<ReservationRecord>(
        `SELECT ${selection} FROM reservation r ${joins} WHERE r.reservationid=$1 ${lock ? 'FOR UPDATE OF r' : ''}`,
        [id],
      )
    ).rows[0] ?? null;
  }
  async overlaps(
    equipmentId: number,
    start: Date,
    end: Date,
    excludeReservationId: number | null = null,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM reservation
      WHERE equipmentid=$1 AND status IN ('confirmed','pending')
        AND ($4::int IS NULL OR reservationid<>$4)
        AND starttime < $3::timestamptz AT TIME ZONE 'UTC'
        AND endtime > $2::timestamptz AT TIME ZONE 'UTC') AS exists`,
      [equipmentId, start, end, excludeReservationId],
    );
    return rows[0]!.exists;
  }
  async roomOverlaps(
    roomId: number,
    start: Date,
    end: Date,
    excludeReservationId: number | null = null,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM reservation
      WHERE roomid=$1 AND status IN ('confirmed','pending')
        AND ($4::int IS NULL OR reservationid<>$4)
        AND starttime < $3::timestamptz AT TIME ZONE 'UTC'
        AND endtime > $2::timestamptz AT TIME ZONE 'UTC') AS exists`,
      [roomId, start, end, excludeReservationId],
    );
    return rows[0]!.exists;
  }
  async equipmentCooldown(
    equipmentId: number,
    start: Date,
    end: Date,
    excludeReservationId: number | null = null,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM reservation
      WHERE equipmentid=$1 AND status IN ('confirmed','pending')
        AND ($4::int IS NULL OR reservationid<>$4)
        AND starttime < ($3::timestamptz AT TIME ZONE 'UTC') + INTERVAL '${RESERVATION_COOLDOWN_MINUTES} minutes'
        AND endtime > ($2::timestamptz AT TIME ZONE 'UTC') - INTERVAL '${RESERVATION_COOLDOWN_MINUTES} minutes') AS exists`,
      [equipmentId, start, end, excludeReservationId],
    );
    return rows[0]!.exists;
  }
  async roomCooldown(
    userId: number,
    roomId: number,
    start: Date,
    end: Date,
    excludeReservationId: number | null = null,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM reservation
      WHERE userid=$1 AND roomid=$2 AND status IN ('confirmed','pending')
        AND ($5::int IS NULL OR reservationid<>$5)
        AND starttime < ($4::timestamptz AT TIME ZONE 'UTC') + INTERVAL '${RESERVATION_COOLDOWN_MINUTES} minutes'
        AND endtime > ($3::timestamptz AT TIME ZONE 'UTC') - INTERVAL '${RESERVATION_COOLDOWN_MINUTES} minutes') AS exists`,
      [userId, roomId, start, end, excludeReservationId],
    );
    return rows[0]!.exists;
  }
  async create(input: ReservationWrite & { status?: 'pending' | 'confirmed' }): Promise<ReservationRecord> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reservation
      (userid,equipmentid,roomid,waiverid,location,starttime,endtime,status,statusdesc)
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz AT TIME ZONE 'UTC',$7::timestamptz AT TIME ZONE 'UTC',$8,'Created through member portal')
      RETURNING reservationid AS id`,
      [
        input.userId,
        input.equipmentId ?? null,
        input.roomId ?? null,
        input.waiverId,
        input.location,
        input.start,
        input.end,
        input.status ?? 'confirmed',
      ],
    );
    return (
      await this.db.query<ReservationRecord>(
        `SELECT ${selection} FROM reservation r ${joins} WHERE r.reservationid=$1`,
        [rows[0]!.id],
      )
    ).rows[0]!;
  }
  async update(id: number, input: ReservationWrite): Promise<ReservationRecord | null> {
    const { rows } = await this.db.query<{ id: number }>(
      `UPDATE reservation SET userid=$2,equipmentid=$3,roomid=$4,waiverid=$5,location=$6,
      starttime=$7::timestamptz AT TIME ZONE 'UTC',endtime=$8::timestamptz AT TIME ZONE 'UTC',
      status='confirmed',statusdesc='Modified by staff',revision=revision+1
      WHERE reservationid=$1 AND status IN ('confirmed','pending')
      RETURNING reservationid AS id`,
      [
        id,
        input.userId,
        input.equipmentId ?? null,
        input.roomId ?? null,
        input.waiverId,
        input.location,
        input.start,
        input.end,
      ],
    );
    if (!rows[0]) return null;
    return this.find(id);
  }
  async cancel(id: number, userId: number): Promise<ReservationRecord | null> {
    const { rows } = await this.db.query<{ id: number }>(
      `UPDATE reservation SET status='cancelled',statusdesc='Cancelled by member'
      WHERE reservationid=$1 AND userid=$2 AND status IN ('confirmed','pending')
        AND NOT EXISTS(SELECT 1 FROM app_equipment_checkout c WHERE c.reservation_id=reservation.reservationid AND c.status='pending')
        AND starttime >= (NOW() + interval '24 hours') AT TIME ZONE 'UTC' RETURNING reservationid AS id`,
      [id, userId],
    );
    if (!rows[0]) return null;
    return (await this.db.query<ReservationRecord>(`SELECT ${selection} FROM reservation r ${joins} WHERE r.reservationid=$1`,[id])).rows[0] ?? null;
  }
  async cancelAny(id: number): Promise<ReservationRecord | null> {
    const before = await this.find(id, true);
    if (!before || (before.status !== 'confirmed' && before.status !== 'pending')) return null;
    if (before.paymentStatus === 'pending' && before.payerId != null)
      throw new AppError(409, 'PAYMENT_WORKFLOW_REQUIRED', 'Cancel the pending Stripe checkout before cancelling this reservation.');
    await this.db.query(
      `UPDATE reservation SET status='cancelled',statusdesc='Cancelled by staff' WHERE reservationid=$1`,
      [id],
    );
    return this.find(id);
  }
}
