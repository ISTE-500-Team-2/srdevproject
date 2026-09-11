import type { Database } from '../db.js';

export class MemberModel {
  constructor(private db: Database) {}
  async certifications(userId: number) {
    return (
      await this.db.query(
        `SELECT c.certid AS id,c.name,uc.status,uc.renewaldate AT TIME ZONE 'UTC' AS "renewalDate",
      (uc.status='active' AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')
      AND (c.effectivedate IS NULL OR c.effectivedate<=NOW() AT TIME ZONE 'UTC')
      AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC')) AS valid
      FROM user_certifications uc JOIN certifications c USING(certid) WHERE uc.userid=$1 ORDER BY c.name`,
        [userId],
      )
    ).rows;
  }
  async signWaiver(userId: number, waiverId: number) {
    await this.db.query(
      `INSERT INTO user_waiver (userid,waiverid,signdate,approval)
      VALUES ($1,$2,NOW() AT TIME ZONE 'UTC',true) ON CONFLICT (userid,waiverid) WHERE approval=true DO NOTHING`,
      [userId, waiverId],
    );
  }
  async activeReservationCount(userId: number): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reservation WHERE userid=$1
      AND status IN ('confirmed','pending') AND endtime>NOW() AT TIME ZONE 'UTC'`,
      [userId],
    );
    return rows[0]!.count;
  }
  async recentCheckIns(userId: number) {
    return (
      await this.db.query(
        `SELECT checkinid AS id,location,checkintime AT TIME ZONE 'UTC' AS "checkedInAt"
      FROM check_in WHERE userid=$1 ORDER BY checkintime DESC LIMIT 5`,
        [userId],
      )
    ).rows;
  }
  async createCheckIn(userId: number, location: string) {
    const { rows } = await this.db.query(
      `INSERT INTO check_in (userid,location,checkintime,status,statusdesc)
      VALUES ($1,$2,NOW() AT TIME ZONE 'UTC','approved','Eligibility verified by member portal')
      RETURNING checkinid AS id,location,checkintime AT TIME ZONE 'UTC' AS "checkedInAt"`,
      [userId, location],
    );
    return rows[0]!;
  }
}
