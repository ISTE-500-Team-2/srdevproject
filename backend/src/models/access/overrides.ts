// Staff-supervised access overrides (app_access_override) and the booking each one rides on.
// An override targets a room or a piece of equipment.

import type { Database } from "../../db.js";

/** The resource table and its key column for an override's target kind. */
const target = (kind: unknown) =>
  kind === "room"
    ? { table: "room", key: "roomid" }
    : { table: "equipment", key: "equipmentid" };

/** An override row as stored. */
export interface OverrideRow {
  id: number;
  user_id: number;
  target_kind: string;
  target_id: number;
  ends_at: Date;
  reason: string;
  created_by: number;
  reservationid: number;
  owns_reservation: boolean;
  revoked_at: Date | null;
}

/** Override grants and revocations, with the supervised booking they use. */
export class AccessOverrideRepository {
  constructor(private db: Database) {}
  async forMember(userId: number) {
    return (
      await this.db.query(
        `SELECT o.id,o.target_kind AS kind,o.target_id AS "resourceId",o.ends_at AS "endsAt",o.reason,o.revoked_at AS "revokedAt",
              COALESCE(e.name,r.name,'Unavailable resource') AS "resourceName" FROM app_access_override o
              LEFT JOIN equipment e ON o.target_kind='equipment' AND e.equipmentid=o.target_id
              LEFT JOIN room r ON o.target_kind='room' AND r.roomid=o.target_id WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  async lockResource(kind: unknown, id: number) {
    const { table, key } = target(kind);
    return (
      await this.db.query<{ name: string; status: string }>(
        `SELECT name,status FROM ${table} WHERE ${key}=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }
  /**
   * A class booking holding this resource before the override ends (row count). A class's
   * booking is held by whoever scheduled it but never admits them (AccessService), so it can't
   * carry an override.
   */
  async classBookings(kind: unknown, id: number, ends: Date) {
    const { key } = target(kind);
    return (
      await this.db.query(
        `SELECT 1 FROM reservation r JOIN app_training_class c ON c.reservation_id=r.reservationid
              WHERE r.${key}=$1 AND r.status IN ('confirmed','pending') AND r.starttime<$2::timestamptz AT TIME ZONE 'UTC'
              AND r.endtime>NOW() AT TIME ZONE 'UTC' LIMIT 1`,
        [id, ends],
      )
    ).rowCount;
  }
  /** The member's own confirmed booking of this resource running now, if any. */
  async lockCurrentReservation(userId: number, kind: unknown, id: number) {
    const { key } = target(kind);
    return (
      await this.db.query<{ id: number; endsAt: Date }>(
        `SELECT reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt" FROM reservation r
            WHERE userid=$1 AND ${key}=$2 AND status='confirmed' AND starttime<=NOW() AT TIME ZONE 'UTC'
            AND endtime>NOW() AT TIME ZONE 'UTC'
            AND NOT EXISTS (SELECT 1 FROM app_training_class c WHERE c.reservation_id=r.reservationid)
            ORDER BY endtime LIMIT 1 FOR UPDATE`,
        [userId, id],
      )
    ).rows[0];
  }
  async createReservation(
    userId: number,
    kind: unknown,
    id: number,
    location: string,
    ends: Date,
  ): Promise<{ id: number; endsAt: Date }> {
    const { key } = target(kind);
    return (
      await this.db.query<{ id: number; endsAt: Date }>(
        `INSERT INTO reservation(userid,${key},location,starttime,endtime,status,statusdesc)
           VALUES($1,$2,$3,NOW() AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC','confirmed','Staff supervised access')
           RETURNING reservationid AS id,endtime AT TIME ZONE 'UTC' AS "endsAt"`,
        [userId, id, location, ends],
      )
    ).rows[0]!;
  }
  async create(
    userId: number,
    kind: unknown,
    id: number,
    endsAt: Date,
    reason: string,
    createdBy: number,
    reservationId: number,
    ownsReservation: boolean,
  ): Promise<OverrideRow> {
    return (
      await this.db.query<OverrideRow>(
        "INSERT INTO app_access_override(user_id,target_kind,target_id,ends_at,reason,created_by,reservationid,owns_reservation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          userId,
          kind,
          id,
          endsAt,
          reason,
          createdBy,
          reservationId,
          ownsReservation,
        ],
      )
    ).rows[0]!;
  }
  async lock(id: number) {
    return (
      await this.db.query<OverrideRow>(
        "SELECT * FROM app_access_override WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
  }
  /** Cancels the booking an override made, if it is still confirmed. */
  async cancelReservation(reservationId: number, userId: number) {
    return (
      await this.db.query<{ id: number }>(
        "UPDATE reservation SET status='cancelled',revision=revision+1 WHERE reservationid=$1 AND userid=$2 AND status='confirmed' RETURNING reservationid AS id",
        [reservationId, userId],
      )
    ).rows[0];
  }
  async revoke(id: number): Promise<OverrideRow> {
    return (
      await this.db.query<OverrideRow>(
        "UPDATE app_access_override SET revoked_at=NOW() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0]!;
  }
}
