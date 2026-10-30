import type { Database } from "./db.js";

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
    SELECT userid,status,startdate AT TIME ZONE 'UTC' AS starts,end_date AT TIME ZONE 'UTC' AS ends
    FROM user_membership
  ), first_memberships AS (
    SELECT userid,MIN(starts) AS starts FROM membership_windows GROUP BY userid
  ) SELECT to_char(p.d,'YYYY-MM-DD') AS period,
    (SELECT COUNT(*)::int FROM first_memberships f WHERE f.starts>=p.a AND f.starts<p.b) AS "newMembers",
    (SELECT COUNT(DISTINCT m.userid)::int FROM membership_windows m WHERE m.status='active'
      AND m.starts<p.b AND m.ends>p.a) AS "activeMembers",
    (SELECT COUNT(DISTINCT m.userid)::int FROM membership_windows m WHERE m.status='active'
      AND m.ends>=p.a AND m.ends<p.b
      AND NOT EXISTS(SELECT 1 FROM membership_windows n WHERE n.userid=m.userid AND n.status='active'
        AND n.starts<=m.ends AND n.ends>m.ends)) AS "expiringMembers",
    (SELECT COUNT(DISTINCT b.userid)::int FROM app_membership_billing b WHERE
      (b.cancellation_confirmed=true OR EXISTS(SELECT 1 FROM app_notification_outbox n
        WHERE n.kind='membership_cancelled' AND n.dedupe_key='membership-cancel:'||b.id::text))
      AND b.cancellation_requested_at>=p.a AND b.cancellation_requested_at<p.b) AS "cancelledMembers"
    FROM periods p ORDER BY p.d`,
    [from, to, timeZone],
  );
  return rows;
}

export const membershipReportNotes = [
  "Membership counts are distinct people per period. New means first recorded membership start; renewals are not new members.",
  "Active means a currently active membership record overlaps the period; these are current-record coverage counts, not reconstructed historical account eligibility. Expiring means a recorded period ends without another currently active period continuing it.",
  "Cancelled counts confirmed recurring-billing cancellation requests by request date, using the confirmation flag or the durable cancellation-confirmation event (independent of email delivery). Paid access may remain active until its end date. Abandoned checkouts, expiry, suspension and manual revocation are not cancellation requests; undated legacy cancellations cannot be placed in a trend.",
];
