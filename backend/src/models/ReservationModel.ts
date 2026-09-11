import type { Database } from '../db.js';

const selection = `r.reservationid AS id,r.userid AS "userId",r.equipmentid AS "equipmentId",e.name AS "equipmentName",
 r.starttime AT TIME ZONE 'UTC' AS "startTime",r.endtime AT TIME ZONE 'UTC' AS "endTime",r.location,r.status`;

export class ReservationModel {
  constructor(private db: Database) {}
  async listForUser(userId: number) {
    return (
      await this.db.query(
        `SELECT ${selection} FROM reservation r JOIN equipment e USING (equipmentid) WHERE r.userid=$1 ORDER BY r.starttime DESC LIMIT 100`,
        [userId],
      )
    ).rows;
  }
  async overlaps(
    equipmentId: number,
    start: Date,
    end: Date,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM reservation
      WHERE equipmentid=$1 AND status IN ('confirmed','pending')
        AND starttime < $3::timestamptz AT TIME ZONE 'UTC'
        AND endtime > $2::timestamptz AT TIME ZONE 'UTC') AS exists`,
      [equipmentId, start, end],
    );
    return rows[0]!.exists;
  }
  async create(input: {
    userId: number;
    equipmentId: number;
    waiverId: number | null;
    location: string;
    start: Date;
    end: Date;
  }) {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reservation
      (userid,equipmentid,waiverid,location,starttime,endtime,status,statusdesc)
      VALUES ($1,$2,$3,$4,$5::timestamptz AT TIME ZONE 'UTC',$6::timestamptz AT TIME ZONE 'UTC','confirmed','Created through member portal')
      RETURNING reservationid AS id`,
      [
        input.userId,
        input.equipmentId,
        input.waiverId,
        input.location,
        input.start,
        input.end,
      ],
    );
    return (
      await this.db.query(
        `SELECT ${selection} FROM reservation r JOIN equipment e USING (equipmentid) WHERE r.reservationid=$1`,
        [rows[0]!.id],
      )
    ).rows[0]!;
  }
  async cancel(id: number, userId: number) {
    const { rows } = await this.db.query(
      `UPDATE reservation SET status='cancelled',statusdesc='Cancelled by member'
      WHERE reservationid=$1 AND userid=$2 AND status IN ('confirmed','pending')
        AND starttime > NOW() AT TIME ZONE 'UTC' RETURNING reservationid AS id`,
      [id, userId],
    );
    return rows[0] ?? null;
  }
}
