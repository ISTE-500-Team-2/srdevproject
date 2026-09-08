import type { Database } from "../db.js";

export class EligibilityModel {
  constructor(
    private db: Database,
    private timeZone: string,
  ) {}

  async entitlement(userId: number, start: Date, end = start) {
    const { rows } = await this.db.query<{
      membership: boolean;
      dayPass: boolean;
    }>(
      `
      SELECT EXISTS (SELECT 1 FROM user_membership WHERE userid=$1 AND status='active'
                     AND startdate <= $2::timestamptz AT TIME ZONE 'UTC'
                     AND end_date > $2::timestamptz AT TIME ZONE 'UTC'
                     AND end_date >= $3::timestamptz AT TIME ZONE 'UTC') AS membership,
             EXISTS (SELECT 1 FROM day_pass WHERE userid=$1 AND status='active'
                     AND validdate::date = ($2::timestamptz AT TIME ZONE $4)::date
                     AND validdate::date = ($3::timestamptz AT TIME ZONE $4)::date) AS "dayPass"`,
      [userId, start, end, this.timeZone],
    );
    return rows[0]!;
  }

  async waivers(userId: number) {
    const { rows } = await this.db.query<{
      id: number;
      name: string;
      version: string;
      description: string;
      signed: boolean;
      signedAt: Date | null;
    }>(
      `
      WITH current_waivers AS (
        SELECT DISTINCT ON (name) * FROM waiver WHERE isactive=true AND required=true
          AND (effectivedate IS NULL OR effectivedate <= NOW() AT TIME ZONE 'UTC')
        ORDER BY name, effectivedate DESC NULLS LAST, waiverid DESC
      )
      SELECT w.waiverid AS id,w.name,w.version,COALESCE(w.description,'') AS description,
             uw.userwaiverid IS NOT NULL AS signed, uw.signdate AT TIME ZONE 'UTC' AS "signedAt"
      FROM current_waivers w LEFT JOIN LATERAL (
        SELECT userwaiverid,signdate FROM user_waiver WHERE userid=$1 AND waiverid=w.waiverid AND approval=true
        ORDER BY signdate DESC LIMIT 1
      ) uw ON true ORDER BY w.name`,
      [userId],
    );
    return rows;
  }

  async certification(
    userId: number,
    certId: number,
    through: Date,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ valid: boolean }>(
      `
      SELECT EXISTS (SELECT 1 FROM user_certifications uc JOIN certifications c USING (certid)
       WHERE uc.userid=$1 AND uc.certid=$2 AND uc.status='active'
        AND (uc.renewaldate IS NULL OR uc.renewaldate >= $3::timestamptz AT TIME ZONE 'UTC')
        AND (c.effectivedate IS NULL OR c.effectivedate <= NOW() AT TIME ZONE 'UTC')
        AND (c.enddate IS NULL OR c.enddate >= $3::timestamptz AT TIME ZONE 'UTC')) AS valid`,
      [userId, certId, through],
    );
    return rows[0]!.valid;
  }
}
