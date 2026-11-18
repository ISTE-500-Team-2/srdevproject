// Membership trend queries separate historical enrollment from currently effective access.

import type { Database } from "./db.js";
import { AUTO_RENEWING_PERIODS } from "./billing/policy.js";

/** Memberships are people, not invoices: renewals never become new members. */
export async function membershipTrends(
  db: Database,
  from: Date,
  to: Date,
  timeZone: string,
  bucket: "day" | "week" | "month",
) {
  const { rows } = await db.query(
    `WITH periods AS MATERIALIZED (
    SELECT d, GREATEST(d AT TIME ZONE $3,$1::timestamptz) AS a,
      LEAST((d+INTERVAL '1 ${bucket}') AT TIME ZONE $3,$2::timestamptz) AS b
    FROM generate_series(date_trunc('${bucket}',$1::timestamptz AT TIME ZONE $3),
      date_trunc('${bucket}',($2::timestamptz-INTERVAL '1 microsecond') AT TIME ZONE $3),INTERVAL '1 ${bucket}') d
  ), membership_windows AS MATERIALIZED (
    -- Convert each stored UTC boundary once, not once per member per bucket.
    -- A card subscription still set to renew has not lapsed, even before its next invoice posts.
    -- An uncorrelated set, so the plan is costed as one hashed lookup rather than a scan per membership.
    SELECT userid,status,startdate AT TIME ZONE 'UTC' AS starts,end_date AT TIME ZONE 'UTC' AS ends,
      membershipid IN (${AUTO_RENEWING_PERIODS}) AS renewing
    FROM user_membership
  ), cancellations AS MATERIALIZED (
    -- Resolve durable cancellation evidence once, not once per estimated bucket.
    -- Repeating this correlated scan can trigger expensive JIT on sparse databases.
    SELECT b.userid,b.cancellation_requested_at FROM app_membership_billing b WHERE
      b.cancellation_confirmed=true OR EXISTS(SELECT 1 FROM app_notification_outbox n
        WHERE n.kind='membership_cancelled' AND n.dedupe_key='membership-cancel:'||b.id::text)
    UNION ALL
    SELECT userid,cancellation_requested_at FROM user_membership WHERE cancellation_requested_at IS NOT NULL
  ), first_memberships AS (
    SELECT userid,MIN(starts) AS starts FROM membership_windows GROUP BY userid
  ) SELECT to_char(p.d,'YYYY-MM-DD') AS period,
    (SELECT COUNT(*)::int FROM first_memberships f WHERE f.starts>=p.a AND f.starts<p.b) AS "newMembers",
    (SELECT COUNT(DISTINCT m.userid)::int FROM membership_windows m WHERE m.status='active'
      AND m.starts<p.b AND m.ends>p.a) AS "activeMembers",
    (SELECT COUNT(DISTINCT m.userid)::int FROM membership_windows m WHERE m.status='active'
      AND m.ends>=p.a AND m.ends<p.b AND m.ends<=NOW() AND NOT m.renewing
      AND NOT EXISTS(SELECT 1 FROM membership_windows n WHERE n.userid=m.userid AND n.status='active'
        AND n.starts<=m.ends AND n.ends>m.ends)) AS "endedWithoutRenewingMembers",
    (SELECT COUNT(DISTINCT b.userid)::int FROM cancellations b WHERE
      b.cancellation_requested_at>=p.a AND b.cancellation_requested_at<p.b) AS "cancelledMembers"
    FROM periods p ORDER BY p.d`,
    [from, to, timeZone],
  );
  return rows;
}

/**
 * People whose current membership ends within the next `days` days with nothing set to carry them on:
 * no later active period that starts by its end, and not a card subscription still set to renew
 * (the same rule as "ended without renewing", looking forward). Active accounts only, like the
 * active membership count beside it.
 */
export async function membersEndingSoon(db: Database, days = 30): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT COUNT(DISTINCT m.userid)::int AS count FROM user_membership m JOIN "user" u USING(userid)
    WHERE m.status='active' AND u.status='active'
      AND m.startdate<=NOW() AT TIME ZONE 'UTC' AND m.end_date>NOW() AT TIME ZONE 'UTC'
      AND m.end_date<=(NOW()+make_interval(days=>$1)) AT TIME ZONE 'UTC'
      AND m.membershipid NOT IN (${AUTO_RENEWING_PERIODS})
      AND NOT EXISTS(SELECT 1 FROM user_membership n WHERE n.userid=m.userid AND n.status='active'
        AND n.startdate<=m.end_date AND n.end_date>m.end_date)`,
    [days],
  );
  return rows[0]!.count;
}

export const membershipReportNotes = [
  "Membership counts are distinct people per period. New means first recorded membership start; renewals are not new members.",
  "Active means a currently active membership record overlaps the period; these are current-record coverage counts, not reconstructed historical account eligibility. Ended without renewing means a recorded period has already ended without another currently active period continuing it; a card subscription still set to renew is not counted while its next payment posts.",
  "Members ending within 30 days is a live count, independent of the report dates: active accounts whose current membership ends in the next 30 days with no later period to continue it and no card subscription set to renew it.",
  "Cancelled counts member cancellations of desk-issued memberships plus confirmed recurring-billing cancellation requests by request date, using the confirmation flag or the durable cancellation-confirmation event (independent of email delivery). Paid access may remain active until its end date. Abandoned checkouts, expiry, suspension and manual revocation are not cancellation requests; undated legacy cancellations cannot be placed in a trend.",
];
