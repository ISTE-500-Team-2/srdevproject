import type { Pool } from "pg";
import { transaction } from "../db.js";
import { AppError } from "../domain.js";
import { checkInOriginSql } from "../models/checkInOrigin.js";
import {
  membershipTrends,
  membershipReportNotes,
} from "../membershipReports.js";
import { notificationMetrics } from "../notifications/store.js";
import type {
  ActiveSummary,
  AuthorizedUsageRow,
  CheckedInPerson,
  ClassFillRow,
  ComplianceSummary,
  EquipmentUtilizationRow,
  LiveLeaseRow,
  ReportData,
  ReportPeriod,
  ReportRequest,
  RevenueRow,
  RoomVisitRow,
  UsagePatternRow,
  VisitDayRow,
} from "./types.js";

const PERIODS: readonly ReportPeriod[] = ["daily", "weekly", "monthly"];

/** Validates the report query: two real ISO dates, at most 93 days inclusive, and a period. */
export function parseReportRequest(query: Record<string, unknown>): ReportRequest {
  const from = typeof query.from === "string" ? query.from : "",
    to = typeof query.to === "string" ? query.to : "",
    period = query.period ?? "daily";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(Date.parse(from)) ||
    new Date(from).toISOString().slice(0, 10) !== from ||
    !Number.isFinite(Date.parse(to)) ||
    new Date(to).toISOString().slice(0, 10) !== to ||
    !PERIODS.includes(String(period) as ReportPeriod)
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Choose valid report dates and period.",
    );
  const delta = Date.parse(to) - Date.parse(from);
  if (delta < 0 || delta > 92 * 86400000)
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Choose an inclusive date range of at most 93 days.",
    );
  return { from, to, period: period as ReportPeriod };
}

/** Reads every report section from one read-only snapshot. */
export function loadReport(
  pool: Pool,
  tz: string,
  { from, to, period }: ReportRequest,
): Promise<ReportData> {
  const bucket =
    period === "daily" ? "day" : period === "weekly" ? "week" : "month";
  return transaction(pool, async (db): Promise<ReportData> => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await db.query("SET LOCAL statement_timeout=10000");
    const bounds = (
      await db.query<{ a: Date; b: Date }>(
        `SELECT $1::date::timestamp AT TIME ZONE $3 AS a,($2::date+1)::timestamp AT TIME ZONE $3 AS b`,
        [from, to, tz],
      )
    ).rows[0]!;
    const params = [bounds.a, bounds.b, tz];
    const memberships = await membershipTrends(
      db,
      bounds.a,
      bounds.b,
      tz,
      bucket,
    );
    const notifications = await notificationMetrics(db, {
      from: bounds.a,
      to: bounds.b,
    });
    const revenue = (
      await db.query<RevenueRow>(
        `WITH ledger AS (
 SELECT p.paymentdate AT TIME ZONE 'UTC' AS at,COALESCE(m.plan_snapshot->>'name',d.plan_snapshot->>'name',t.tiername,'Unclassified payment') AS category,p.method,
 p.price AS gross,CASE WHEN p.paymentstatus='refunded' THEN p.price ELSE 0 END AS refunds
 FROM payment p LEFT JOIN user_membership m USING(membershipid) LEFT JOIN membership_tiers t ON t.tierid=m.tierid
 LEFT JOIN LATERAL(SELECT plan_snapshot FROM day_pass WHERE paymentid=p.paymentid ORDER BY dayid LIMIT 1) d ON true
 WHERE p.paymentstatus IN ('paid','refunded')
 UNION ALL SELECT created_at,'Studio rental',payment_method,amount_cents/100.0,CASE WHEN payment_status='refunded' THEN refund_cents/100.0 ELSE 0 END FROM app_studio_rental WHERE payment_status IN ('paid','refund_pending','refunded','refund_failed'))
 SELECT to_char(date_trunc('${bucket}',at AT TIME ZONE $3),'YYYY-MM-DD') AS period,category,method,COUNT(*)::int AS receipts,SUM(gross)::text AS gross,SUM(refunds)::text AS refunds,SUM(gross-refunds)::text AS net
 FROM ledger WHERE at>=$1 AND at<$2 GROUP BY 1,2,3 ORDER BY 1,2,3`,
        params,
      )
    ).rows;
    const equipment = (
      await db.query<EquipmentUtilizationRow>(
        `SELECT e.equipmentid AS id,e.name,COALESCE(SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz))) FILTER (WHERE v.reservationid IS NOT NULL)/3600,0)::float AS "bookedHours",COUNT(v.reservationid)::int AS reservations,
 EXTRACT(EPOCH FROM $2::timestamptz-$1::timestamptz)/3600 AS "windowHours",COALESCE(100*SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz))) FILTER (WHERE v.reservationid IS NOT NULL)/EXTRACT(EPOCH FROM $2::timestamptz-$1::timestamptz),0)::float AS "bookedUtilizationPercent"
 FROM equipment e LEFT JOIN reservation v ON v.equipmentid=e.equipmentid AND v.status='confirmed' AND v.endtime AT TIME ZONE 'UTC'>$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY e.equipmentid,e.name ORDER BY e.name`,
        params.slice(0, 2),
      )
    ).rows;
    const patterns = (
      await db.query<UsagePatternRow>(
        `SELECT e.equipmentid AS id,e.name,EXTRACT(ISODOW FROM h AT TIME ZONE $3)::int AS weekday,EXTRACT(HOUR FROM h AT TIME ZONE $3)::int AS hour,
 SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',h+interval '1 hour',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',h,$1::timestamptz)))/3600 AS "bookedHours"
 FROM reservation v JOIN equipment e USING(equipmentid) CROSS JOIN LATERAL generate_series(date_trunc('hour',GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz)),LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-interval '1 microsecond',interval '1 hour') h
 WHERE v.status='confirmed' AND v.endtime AT TIME ZONE 'UTC'>$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY e.equipmentid,e.name,weekday,hour ORDER BY e.name,weekday,hour`,
        params,
      )
    ).rows;
    const classes = (
      await db.query<ClassFillRow>(
        // Enrollment caps legacy larger classes at 15 seats; report the same limit.
        `SELECT c.id,c.title,LEAST(c.capacity,15) AS capacity,c.status,v.starttime AT TIME ZONE 'UTC' AS "startsAt",room.name AS room,
 COUNT(e.user_id) FILTER(WHERE e.status IN ('enrolled','attended'))::int AS enrolled,COUNT(e.user_id) FILTER(WHERE e.status='attended')::int AS attended,
 100.0*COUNT(e.user_id) FILTER(WHERE e.status IN ('enrolled','attended'))/LEAST(c.capacity,15) AS "filledPercent"
 FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id JOIN room USING(roomid) LEFT JOIN app_training_enrollment e ON e.class_id=c.id
 WHERE v.starttime AT TIME ZONE 'UTC'>=$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY c.id,v.starttime,room.name ORDER BY v.starttime`,
        params.slice(0, 2),
      )
    ).rows;
    const rooms = (
      await db.query<RoomVisitRow>(
        `SELECT room.roomid AS id,room.name,room.capacity,COUNT(DISTINCT i.checkinid)::int AS "recordedCheckIns",COUNT(DISTINCT i.userid)::int AS "distinctVisitors"
 FROM room LEFT JOIN check_in i ON i.roomid=room.roomid AND i.status='approved' AND i.checkintime AT TIME ZONE 'UTC'>=$1 AND i.checkintime AT TIME ZONE 'UTC'<$2 GROUP BY room.roomid ORDER BY room.name`,
        params.slice(0, 2),
      )
    ).rows;
    const active = (
      await db.query<ActiveSummary>(
        `SELECT COUNT(DISTINCT userid)::int AS "activeUsers",COUNT(*)::int AS "approvedCheckIns" FROM check_in WHERE status='approved' AND checkintime AT TIME ZONE 'UTC'>=$1 AND checkintime AT TIME ZONE 'UTC'<$2`,
        params.slice(0, 2),
      )
    ).rows[0]!;
    // Visits per local day across the whole window, zero-filled so quiet
    // days show as gaps rather than disappearing.
    const visitsByDay = (
      await db.query<VisitDayRow>(
        `SELECT to_char(d,'YYYY-MM-DD') AS day,COUNT(i.checkinid)::int AS visits,COUNT(DISTINCT i.userid)::int AS people
 FROM generate_series($2::date,$3::date,interval '1 day') d
 LEFT JOIN check_in i ON i.status='approved' AND (i.checkintime AT TIME ZONE 'UTC' AT TIME ZONE $1)::date=d::date
 GROUP BY d ORDER BY d`,
        [tz, from, to],
      )
    ).rows;
    // There is no check-out record, so this is who checked in today (each
    // person's latest check-in), not a live headcount.
    const recentCheckIns = (
      await db.query<CheckedInPerson & { total: number }>(
        `SELECT latest.*,COUNT(*) OVER()::int AS total FROM (
 SELECT DISTINCT ON (i.userid) i.userid AS "userId",u.firstname || ' ' || u.lastname AS name,i.location,
 i.checkintime AT TIME ZONE 'UTC' AS at,${checkInOriginSql("i")} AS method
 FROM check_in i JOIN "user" u USING(userid)
 WHERE i.status='approved' AND i.checkintime AT TIME ZONE 'UTC'>=date_trunc('day',NOW() AT TIME ZONE $1) AT TIME ZONE $1
 ORDER BY i.userid,i.checkintime DESC,i.checkinid DESC
 ) latest ORDER BY at DESC,"userId" LIMIT 50`,
        [tz],
      )
    ).rows;
    const checkedInTodayCount = recentCheckIns[0]?.total ?? 0;
    const checkedInToday = recentCheckIns.map(({ total, ...person }) => person);
    const compliance = (
      await db.query<ComplianceSummary>(
        `SELECT COUNT(*) FILTER(WHERE status='active')::int AS "activeAccounts",COUNT(*) FILTER(WHERE accessstatus<>'active')::int AS "restrictedAccounts",(SELECT COUNT(*)::int FROM user_certifications WHERE status='active' AND renewaldate<NOW() AT TIME ZONE 'UTC') AS "expiredTraining",
        (SELECT COUNT(*)::int FROM user_certifications WHERE status='active' AND renewaldate IS NULL) AS "trainingWithoutExpiry",
        (SELECT COUNT(*)::int FROM user_membership um JOIN "user" mu USING(userid) WHERE um.status='active' AND mu.status='active'
          AND um.startdate<=NOW() AT TIME ZONE 'UTC' AND um.end_date>NOW() AT TIME ZONE 'UTC') AS "activeMemberships",
        (SELECT COUNT(*)::int FROM user_waiver uw WHERE uw.approval=true AND NOT EXISTS(SELECT 1 FROM app_signed_waiver_copy c
          WHERE c.userwaiverid=uw.userwaiverid AND c.userid=uw.userid
            AND c.payload ?& ARRAY['waiverName','waiverVersion','waiverText','signature','signedAt'])
          AND NOT EXISTS(SELECT 1 FROM app_notification_outbox o
          WHERE o.dedupe_key='waiver-signed:'||uw.userwaiverid AND o.userid=uw.userid AND o.kind='waiver_signed'
            AND o.payload ?& ARRAY['waiverName','waiverVersion','waiverText','signature','signedAt'])) AS "signaturesWithoutCopy",
        (SELECT COALESCE(json_agg(name ORDER BY name),'[]') FROM equipment WHERE certid IS NULL AND status='available') AS "machinesWithoutTraining"
        FROM "user"`,
      )
    ).rows[0]!;
    const live = (
      await db.query<LiveLeaseRow>(
        `SELECT target_kind AS kind,target_id AS "resourceId",COUNT(DISTINCT user_id)::int AS "activeReaderLeases" FROM app_device_access_event WHERE allowed=true AND expires_at>NOW() GROUP BY target_kind,target_id ORDER BY target_kind,target_id`,
      )
    ).rows;
    const usage = (
      await db.query<AuthorizedUsageRow>(
        `WITH intervals AS (SELECT target_id,range_agg(tstzrange(GREATEST(created_at,$1::timestamptz),LEAST(expires_at,$2::timestamptz),'[)')) AS spans FROM app_device_access_event WHERE allowed=true AND target_kind='equipment' AND expires_at>created_at AND created_at<$2 AND expires_at>$1 GROUP BY target_id)
 SELECT target_id AS "equipmentId",SUM(EXTRACT(EPOCH FROM upper(span)-lower(span)))/3600 AS "authorizedHours" FROM intervals CROSS JOIN LATERAL unnest(spans) span GROUP BY target_id`,
        params.slice(0, 2),
      )
    ).rows;
    return {
      from,
      to,
      timeZone: tz,
      period,
      generatedAt: new Date().toISOString(),
      revenue,
      equipment,
      patterns,
      classes,
      rooms,
      active,
      compliance,
      live,
      usage,
      visitsByDay,
      checkedInToday,
      checkedInTodayCount,
      memberships,
      notifications,
      notes: [
        ...membershipReportNotes,
        "Records granted with under a week left still get a reminder, but do not count toward on-time rates because a week's notice was impossible.",
        "Notification cohorts use deadline dates, not creation dates. Expiration/compliance covers waiver and training reminders only. Provider acceptance, delivered callbacks and inbox placement are different; zero eligible notices means no rate, not 100%.",
        "Revenue groups recorded receipts by original purchase date and current refund state; it is not a historical cash-flow ledger.",
        "Booking utilization uses the full selected calendar window, not operating-hours availability. Reader-authorized time is separately measured and is not proof of physical machine operation.",
        "Room visits are historical check-ins, not current headcount. Active reader leases and verified class attendance are reported separately.",
        "Visits count approved check-ins by day in the reporting time zone. Checked in today lists each person's latest check-in since local midnight; there is no check-out, so it is not a live headcount.",
      ],
    };
  });
}
