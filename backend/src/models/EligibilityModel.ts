// Read-side eligibility queries shared by booking and access checks; timestamps use UTC while day
// passes use the facility's calendar date.

import type { Database } from "../db.js";
import { waiverFormFields } from "../waiverForms.js";
import type { PolicyScope } from "../staffDomain.js";
import { EXPIRATION_LOOKAHEAD_DAYS } from "../notifications/scheduler.js";

/** A member credential ($1) and its certification definition, both valid through $2. */
const VALID_CERTIFICATION = `FROM user_certifications uc JOIN certifications c USING (certid)
       WHERE uc.userid=$1 AND uc.status='active'
        AND (uc.renewaldate IS NULL OR uc.renewaldate >= $2::timestamptz AT TIME ZONE 'UTC')
        AND (c.effectivedate IS NULL OR c.effectivedate <= NOW() AT TIME ZONE 'UTC')
        AND (c.enddate IS NULL OR c.enddate >= $2::timestamptz AT TIME ZONE 'UTC')`;

export class EligibilityModel {
  constructor(
    private db: Database,
    private timeZone: string,
  ) {}

  /**
   * Check coverage for the entire requested interval [start, end); end is exclusive. Active
   * memberships may cover it together when one starts as the previous ends (a renewal). A day pass
   * must cover the facility's local date of start and of the last instant before end, so a slot
   * ending exactly at local midnight still belongs to the pass's day.
   */
  async entitlement(userId: number, start: Date, end = start) {
    const { rows } = await this.db.query<{
      membership: boolean;
      dayPass: boolean;
    }>(
      `
      SELECT COALESCE((SELECT range_agg(tsrange(startdate, end_date)) FROM user_membership
                       WHERE userid=$1 AND status='active' AND startdate < end_date)
               @> CASE WHEN $3::timestamptz > $2::timestamptz
                    THEN tsrange($2::timestamptz AT TIME ZONE 'UTC', $3::timestamptz AT TIME ZONE 'UTC')
                    -- An instant (start = end) is a single point that must fall inside a membership.
                    ELSE tsrange($2::timestamptz AT TIME ZONE 'UTC', $2::timestamptz AT TIME ZONE 'UTC', '[]') END,
             false) AS membership,
             EXISTS (SELECT 1 FROM day_pass WHERE userid=$1 AND status='active'
                     AND validdate::date = ($2::timestamptz AT TIME ZONE $4)::date
                     AND validdate::date = ((CASE WHEN $3::timestamptz > $2::timestamptz
                       THEN $3::timestamptz - interval '1 microsecond' ELSE $2::timestamptz END) AT TIME ZONE $4)::date) AS "dayPass"`,
      [userId, start, end, this.timeZone],
    );
    return rows[0]!;
  }

  /**
   * Whether the member holds a membership or day pass that is current or still to come at `from`.
   * The equipment catalogue uses this so a pass for a later day, or a membership that starts later,
   * doesn't stop booking ahead; each reservation still checks its own time with entitlement().
   */
  async upcomingEntitlement(userId: number, from: Date) {
    const { rows } = await this.db.query<{
      membership: boolean;
      dayPass: boolean;
    }>(
      `
      SELECT EXISTS (SELECT 1 FROM user_membership WHERE userid=$1 AND status='active' AND startdate < end_date
                     AND end_date > $2::timestamptz AT TIME ZONE 'UTC') AS membership,
             EXISTS (SELECT 1 FROM day_pass WHERE userid=$1 AND status='active'
                     AND validdate::date >= ($2::timestamptz AT TIME ZONE $3)::date) AS "dayPass"`,
      [userId, from, this.timeZone],
    );
    return rows[0]!;
  }

  /**
   * Select the latest effective required version per policy name and distinguish missing, outdated
   * and expired signatures.
   */
  async waivers(userId: number, scope?: PolicyScope, through?: Date) {
    const { rows } = await this.db.query<{
      id: number;
      versionId: number;
      name: string;
      version: string;
      description: string;
      scope: PolicyScope;
      signed: boolean;
      signedAt: Date | null;
      signedVersion: string | null;
      signedVersionId: number | null;
      outdatedSignature: boolean;
      expiredSignature: boolean;
      expiresAt: Date | null;
      renewable: boolean;
    }>(
      `
      WITH current_waivers AS (
        SELECT DISTINCT ON (name) * FROM waiver WHERE isactive=true AND required=true
          AND (effectivedate IS NULL OR effectivedate <= NOW() AT TIME ZONE 'UTC')
        ORDER BY name, effectivedate DESC NULLS LAST, waiverid DESC
      )
      SELECT w.waiverid AS id,w.waiverid AS "versionId",w.name,w.version,COALESCE(w.description,'') AS description,w.policy_scope AS scope,
             current_sig.userwaiverid IS NOT NULL AS signed,
             current_sig.signdate AT TIME ZONE 'UTC' AS "signedAt",
             previous_sig.version AS "signedVersion",
             previous_sig.waiverid AS "signedVersionId",
             current_sig.userwaiverid IS NULL AND COALESCE(previous_sig.waiverid <> w.waiverid,false) AS "outdatedSignature",
             current_sig.userwaiverid IS NULL AND COALESCE(previous_sig.waiverid = w.waiverid
               AND (previous_sig.expires_at <= NOW() OR previous_sig.expires_at < $3::timestamptz),false) AS "expiredSignature",
             -- The current signature's end, or when the last signature of this same version ran out.
             CASE WHEN current_sig.userwaiverid IS NOT NULL THEN current_sig.expires_at
                  WHEN previous_sig.waiverid = w.waiverid THEN previous_sig.expires_at END AS "expiresAt",
             -- Signed but running out within the expiry reminder's window: signing now renews it
             -- (MemberModel.signWaiver supersedes it), so the page offers a new agreement.
             COALESCE(current_sig.expires_at <= NOW()+make_interval(days=>$4::int),false) AS renewable
      FROM current_waivers w LEFT JOIN LATERAL (
        SELECT userwaiverid,signdate,expires_at FROM user_waiver WHERE userid=$1 AND waiverid=w.waiverid AND approval=true
          AND (expires_at IS NULL OR (expires_at>NOW() AND ($3::timestamptz IS NULL OR expires_at >= $3::timestamptz)))
        ORDER BY signdate DESC LIMIT 1
      ) current_sig ON true LEFT JOIN LATERAL (
        SELECT uw.userwaiverid,uw.signdate,uw.expires_at,w2.waiverid,w2.version FROM user_waiver uw JOIN waiver w2 USING(waiverid)
        WHERE uw.userid=$1 AND w2.name=w.name AND uw.approval=true
        ORDER BY uw.signdate DESC,uw.userwaiverid DESC LIMIT 1
      ) previous_sig ON true
      WHERE ($2::text IS NULL OR w.policy_scope=$2) ORDER BY w.name`,
      [userId, scope ?? null, through ?? null, EXPIRATION_LOOKAHEAD_DAYS],
    );
    return rows.map(row => ({ ...row, formFields: waiverFormFields(row.description) }));
  }

  /**
   * Require both the member's credential and the certification definition to remain valid through
   * the requested time.
   */
  async certification(
    userId: number,
    certId: number,
    through: Date,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ valid: boolean }>(
      `SELECT EXISTS (SELECT 1 ${VALID_CERTIFICATION} AND uc.certid=$3) AS valid`,
      [userId, through, certId],
    );
    return rows[0]!.valid;
  }

  /** Every certification the member holds that stays valid through `through`, in one query. */
  async certifications(userId: number, through: Date): Promise<Set<number>> {
    const { rows } = await this.db.query<{ certId: number }>(
      `SELECT DISTINCT uc.certid AS "certId" ${VALID_CERTIFICATION}`,
      [userId, through],
    );
    return new Set(rows.map((row) => row.certId));
  }
}
