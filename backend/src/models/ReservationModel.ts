import type { Database } from '../db.js';

export const RESERVATION_COOLDOWN_MINUTES = 15;

const selection = `r.reservationid AS id,r.userid AS "userId",r.equipmentid AS "equipmentId",r.roomid AS "roomId",
 COALESCE(e.name,room.name) AS "equipmentName",CASE WHEN r.roomid IS NULL THEN 'equipment' ELSE 'room' END AS "resourceType",
 r.starttime AT TIME ZONE 'UTC' AS "startTime",r.endtime AT TIME ZONE 'UTC' AS "endTime",r.location,r.status,
 u.firstname || ' ' || u.lastname AS "memberName",u.email AS "memberEmail"`;
const joins = `LEFT JOIN equipment e USING (equipmentid) LEFT JOIN room ON room.roomid=r.roomid JOIN "user" u ON u.userid=r.userid`;

export class ReservationModel {
  constructor(private db: Database) {}
  async listForUser(userId: number) {
    return (
      await this.db.query(
        `SELECT ${selection} FROM reservation r ${joins} WHERE r.userid=$1 ORDER BY r.starttime DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  async listAll(filters: {
    date?: string;
    userId?: number | null;
    equipmentId?: number | null;
    offset?: number;
  }) {
    const date = filters.date?.trim() || null;
    return (
      await this.db.query(
        `SELECT ${selection} FROM reservation r ${joins}
        WHERE ($1::date IS NULL OR r.starttime::date=$1::date)
          AND ($2::int IS NULL OR r.userid=$2)
          AND ($3::int IS NULL OR r.equipmentid=$3)
        ORDER BY r.starttime DESC,r.reservationid DESC LIMIT 51 OFFSET $4`,
        [
          date,
          filters.userId ?? null,
          filters.equipmentId ?? null,
          filters.offset ?? 0,
        ],
      )
    ).rows;
  }
  async find(id: number, lock = false) {
    return (
      await this.db.query(
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
  async create(input: {
    userId: number;
    equipmentId?: number;
    roomId?: number;
    waiverId: number | null;
    location: string;
    start: Date;
    end: Date;
  }) {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reservation
      (userid,equipmentid,roomid,waiverid,location,starttime,endtime,status,statusdesc)
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz AT TIME ZONE 'UTC',$7::timestamptz AT TIME ZONE 'UTC','confirmed','Created through member portal')
      RETURNING reservationid AS id`,
      [
        input.userId,
        input.equipmentId ?? null,
        input.roomId ?? null,
        input.waiverId,
        input.location,
        input.start,
        input.end,
      ],
    );
    return (
      await this.db.query(
        `SELECT ${selection} FROM reservation r ${joins} WHERE r.reservationid=$1`,
        [rows[0]!.id],
      )
    ).rows[0]!;
  }
  async update(
    id: number,
    input: {
      userId: number;
      equipmentId?: number;
      roomId?: number;
      waiverId: number | null;
      location: string;
      start: Date;
      end: Date;
    },
  ) {
    const { rows } = await this.db.query(
      `UPDATE reservation SET userid=$2,equipmentid=$3,roomid=$4,waiverid=$5,location=$6,
      starttime=$7::timestamptz AT TIME ZONE 'UTC',endtime=$8::timestamptz AT TIME ZONE 'UTC',
      status='confirmed',statusdesc='Modified by staff'
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
  async cancel(id: number, userId: number) {
    const { rows } = await this.db.query(
      `UPDATE reservation SET status='cancelled',statusdesc='Cancelled by member'
      WHERE reservationid=$1 AND userid=$2 AND status IN ('confirmed','pending')
        AND starttime >= (NOW() + interval '24 hours') AT TIME ZONE 'UTC' RETURNING reservationid AS id`,
      [id, userId],
    );
    if (!rows[0]) return null;
    return (await this.db.query(`SELECT ${selection} FROM reservation r ${joins} WHERE r.reservationid=$1`,[id])).rows[0] ?? null;
  }
  async cancelAny(id: number) {
    const before = await this.find(id, true);
    if (!before || !['confirmed', 'pending'].includes(before.status)) return null;
    await this.db.query(
      `UPDATE reservation SET status='cancelled',statusdesc='Cancelled by staff' WHERE reservationid=$1`,
      [id],
    );
    return this.find(id);
  }
}
