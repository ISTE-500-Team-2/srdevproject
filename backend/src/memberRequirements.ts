import type { Database } from "./db.js";
import { AppError } from "./domain.js";
import { EligibilityModel } from "./models/EligibilityModel.js";
import { MinorSupervision } from "./minorSupervision.js";

/**
 * Everything that decides whether a member can use the shop right now, for the
 * staff member record. Advisory only: readers and check-in run their own checks
 * (AccessService, the reader decision) and stay the source of truth.
 */
export async function memberRequirements(db: Database, timeZone: string, userId: number) {
  const user = (
    await db.query<{ status: string; accessStatus: string }>(
      `SELECT status,accessstatus AS "accessStatus" FROM "user" WHERE userid=$1`,
      [userId],
    )
  ).rows[0];
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found.");
  const eligibility = new EligibilityModel(db, timeZone);
  const supervision = new MinorSupervision(db, timeZone);
  const [membership, dayPass, waivers, training, cards, summary] = await Promise.all([
    db.query<{ name: string | null; endsAt: Date }>(
      `SELECT COALESCE(m.plan_snapshot->>'name',t.tiername) AS name,m.end_date AT TIME ZONE 'UTC' AS "endsAt"
       FROM user_membership m LEFT JOIN membership_tiers t USING(tierid)
       WHERE m.userid=$1 AND m.status='active'
         AND m.startdate<=NOW() AT TIME ZONE 'UTC' AND m.end_date>NOW() AT TIME ZONE 'UTC'
       ORDER BY m.end_date DESC LIMIT 1`,
      [userId],
    ),
    db.query<{ name: string | null; validDate: string }>(
      `SELECT COALESCE(d.plan_snapshot->>'name',t.tiername) AS name,to_char(d.validdate,'YYYY-MM-DD') AS "validDate"
       FROM day_pass d LEFT JOIN membership_tiers t USING(tierid)
       WHERE d.userid=$1 AND d.status='active' AND d.validdate::date=(NOW() AT TIME ZONE $2)::date
       LIMIT 1`,
      [userId, timeZone],
    ),
    eligibility.waivers(userId, "facility"),
    // Same test as EligibilityModel.certification, for every machine that needs training.
    db.query<{ name: string; held: boolean }>(
      `SELECT e.name,EXISTS(SELECT 1 FROM user_certifications uc WHERE uc.userid=$1 AND uc.certid=e.certid
          AND uc.status='active' AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')) AS held
       FROM equipment e JOIN certifications c ON c.certid=e.certid
       WHERE (c.effectivedate IS NULL OR c.effectivedate<=NOW() AT TIME ZONE 'UTC')
         AND (c.enddate IS NULL OR c.enddate>=NOW() AT TIME ZONE 'UTC')
       ORDER BY e.name,e.equipmentid`,
      [userId],
    ),
    db.query<{ active: number }>(
      "SELECT count(*)::int AS active FROM app_access_card WHERE user_id=$1 AND active",
      [userId],
    ),
    supervision.summary(userId),
  ]);
  let sponsorHere = false;
  if (summary.isMinor && summary.sponsor) {
    try {
      await supervision.requireSponsor(userId);
      sponsorHere = true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  const signed = waivers.filter((w) => w.signed);
  const membershipRow = membership.rows[0];
  const passRow = dayPass.rows[0];
  return {
    account: user.status,
    access: user.accessStatus,
    entitlement: membershipRow
      ? { kind: "membership" as const, name: membershipRow.name ?? "Membership", endsAt: membershipRow.endsAt }
      : passRow
        ? { kind: "day_pass" as const, name: passRow.name ?? "Day pass", validDate: passRow.validDate }
        : null,
    waivers: {
      required: waivers.length,
      signed: signed.length,
      missing: waivers.filter((w) => !w.signed).map((w) => w.name),
      lastSignedAt: signed.reduce<Date | null>(
        (latest, w) => (w.signedAt && (!latest || w.signedAt > latest) ? w.signedAt : latest),
        null,
      ),
    },
    training: {
      required: training.rows.length,
      held: training.rows.filter((r) => r.held).length,
      missing: training.rows.filter((r) => !r.held).map((r) => r.name),
    },
    cards: { active: cards.rows[0]?.active ?? 0 },
    minor: summary.isMinor
      ? { sponsorName: summary.sponsor?.name ?? null, sponsorHere }
      : null,
    visit: summary.visit,
  };
}
