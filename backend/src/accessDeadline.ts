import type { Database } from './db.js';

// A lease must end before any eligibility condition stops being true. Membership
// and day passes are alternatives; required policies and training are cumulative.
// Compute against one instant, using the same current-policy selection as eligibility.
export async function accessDeadline(
  db: Database, timeZone: string, userId: number,
  reservationEnd: Date, equipmentId?: number, at = new Date(),
): Promise<Date> {
  const cap = new Date(Math.min(at.getTime() + 5000, reservationEnd.getTime()));
  const { rows } = await db.query<{ ends: Date }>(`
    WITH current_policies AS (
      SELECT DISTINCT ON (name) waiverid FROM waiver
      WHERE isactive AND required
        AND (effectivedate IS NULL OR effectivedate <= $2::timestamptz AT TIME ZONE 'UTC')
      ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC
    ), policy_limits AS (
      SELECT COALESCE(MAX(CASE WHEN uw.userwaiverid IS NOT NULL
        THEN COALESCE(uw.expires_at,'infinity'::timestamptz) END),$2::timestamptz) AS ends
      FROM current_policies w LEFT JOIN user_waiver uw ON uw.waiverid=w.waiverid
        AND uw.userid=$1 AND uw.approval
        AND (uw.expires_at IS NULL OR uw.expires_at > $2::timestamptz)
      GROUP BY w.waiverid
    )
    SELECT LEAST($3::timestamptz,
      COALESCE(GREATEST(
        (SELECT MAX(end_date AT TIME ZONE 'UTC') FROM user_membership
         WHERE userid=$1 AND status='active'
           AND startdate <= $2::timestamptz AT TIME ZONE 'UTC'
           AND end_date > $2::timestamptz AT TIME ZONE 'UTC'),
        (SELECT (($2::timestamptz AT TIME ZONE $4)::date+1)::timestamp AT TIME ZONE $4
         WHERE EXISTS (SELECT 1 FROM day_pass WHERE userid=$1 AND status='active'
           AND validdate::date=($2::timestamptz AT TIME ZONE $4)::date))
      ),$2::timestamptz),
      COALESCE((SELECT MIN(ends) FROM policy_limits),$2::timestamptz),
      (SELECT MIN(effectivedate AT TIME ZONE 'UTC') FROM waiver
       WHERE isactive AND required AND effectivedate > $2::timestamptz AT TIME ZONE 'UTC'),
      CASE WHEN EXISTS(SELECT 1 FROM equipment WHERE equipmentid=$5 AND certid IS NOT NULL)
      THEN COALESCE((SELECT MAX(COALESCE(LEAST(uc.renewaldate AT TIME ZONE 'UTC',c.enddate AT TIME ZONE 'UTC'),'infinity'::timestamptz))
       FROM equipment e JOIN certifications c USING(certid)
       JOIN user_certifications uc USING(certid)
       WHERE e.equipmentid=$5 AND uc.userid=$1 AND uc.status='active'
         AND (uc.renewaldate IS NULL OR uc.renewaldate > $2::timestamptz AT TIME ZONE 'UTC')
         AND (c.enddate IS NULL OR c.enddate > $2::timestamptz AT TIME ZONE 'UTC')),$2::timestamptz) END
    ) AS ends`, [userId, at, cap, timeZone, equipmentId ?? null]);
  return rows[0]!.ends;
}
