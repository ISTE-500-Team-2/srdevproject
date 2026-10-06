import { Router } from "express";
import type { Pool } from "pg";
import { transaction } from "./db.js";
import { AppError } from "./domain.js";
import { requirePermission } from "./middleware/permissions.js";
export function reportRoutes(pool: Pool, tz: string) {
  const r = Router();
  r.get(
    ["/admin/reports", "/admin/reports/export"],
    requirePermission(pool, "audit", "read"),
    async (req, res) => {
      const from = typeof req.query.from === "string" ? req.query.from : "",
        to = typeof req.query.to === "string" ? req.query.to : "",
        period = req.query.period ?? "daily";
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
        !Number.isFinite(Date.parse(from)) ||
        new Date(from).toISOString().slice(0, 10) !== from ||
        !Number.isFinite(Date.parse(to)) ||
        new Date(to).toISOString().slice(0, 10) !== to ||
        !["daily", "weekly", "monthly"].includes(String(period))
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
      const bucket =
        period === "daily" ? "day" : period === "weekly" ? "week" : "month";
      const data = await transaction(pool, async (db) => {
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        await db.query("SET LOCAL statement_timeout=10000");
        const bounds = (
          await db.query(
            `SELECT $1::date::timestamp AT TIME ZONE $3 AS a,($2::date+1)::timestamp AT TIME ZONE $3 AS b`,
            [from, to, tz],
          )
        ).rows[0]!;
        const params = [bounds.a, bounds.b, tz];
        const revenue = (
          await db.query(
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
          await db.query(
            `SELECT e.equipmentid AS id,e.name,COALESCE(SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz)))/3600,0)::float AS "bookedHours",COUNT(v.reservationid)::int AS reservations,
 EXTRACT(EPOCH FROM $2::timestamptz-$1::timestamptz)/3600 AS "windowHours",COALESCE(100*SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz)))/EXTRACT(EPOCH FROM $2::timestamptz-$1::timestamptz),0)::float AS "bookedUtilizationPercent"
 FROM equipment e LEFT JOIN reservation v ON v.equipmentid=e.equipmentid AND v.status='confirmed' AND v.endtime AT TIME ZONE 'UTC'>$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY e.equipmentid,e.name ORDER BY e.name`,
            params.slice(0, 2),
          )
        ).rows;
        const patterns = (
          await db.query(
            `SELECT e.equipmentid AS id,e.name,EXTRACT(ISODOW FROM h AT TIME ZONE $3)::int AS weekday,EXTRACT(HOUR FROM h AT TIME ZONE $3)::int AS hour,
 SUM(EXTRACT(EPOCH FROM LEAST(v.endtime AT TIME ZONE 'UTC',h+interval '1 hour',$2::timestamptz)-GREATEST(v.starttime AT TIME ZONE 'UTC',h,$1::timestamptz)))/3600 AS "bookedHours"
 FROM reservation v JOIN equipment e USING(equipmentid) CROSS JOIN LATERAL generate_series(date_trunc('hour',GREATEST(v.starttime AT TIME ZONE 'UTC',$1::timestamptz)),LEAST(v.endtime AT TIME ZONE 'UTC',$2::timestamptz)-interval '1 microsecond',interval '1 hour') h
 WHERE v.status='confirmed' AND v.endtime AT TIME ZONE 'UTC'>$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY e.equipmentid,e.name,weekday,hour ORDER BY e.name,weekday,hour`,
            params,
          )
        ).rows;
        const classes = (
          await db.query(
            `SELECT c.id,c.title,c.capacity,c.status,v.starttime AT TIME ZONE 'UTC' AS "startsAt",room.name AS room,
 COUNT(e.user_id) FILTER(WHERE e.status IN ('enrolled','attended'))::int AS enrolled,COUNT(e.user_id) FILTER(WHERE e.status='attended')::int AS attended,
 100.0*COUNT(e.user_id) FILTER(WHERE e.status IN ('enrolled','attended'))/c.capacity AS "filledPercent"
 FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id JOIN room USING(roomid) LEFT JOIN app_training_enrollment e ON e.class_id=c.id
 WHERE v.starttime AT TIME ZONE 'UTC'>=$1 AND v.starttime AT TIME ZONE 'UTC'<$2 GROUP BY c.id,v.starttime,room.name ORDER BY v.starttime`,
            params.slice(0, 2),
          )
        ).rows;
        const rooms = (
          await db.query(
            `SELECT room.roomid AS id,room.name,room.capacity,COUNT(DISTINCT i.checkinid)::int AS "recordedCheckIns",COUNT(DISTINCT i.userid)::int AS "distinctVisitors"
 FROM room LEFT JOIN check_in i ON i.roomid=room.roomid AND i.status='approved' AND i.checkintime AT TIME ZONE 'UTC'>=$1 AND i.checkintime AT TIME ZONE 'UTC'<$2 GROUP BY room.roomid ORDER BY room.name`,
            params.slice(0, 2),
          )
        ).rows;
        const active = (
          await db.query(
            `SELECT COUNT(DISTINCT userid)::int AS "activeUsers",COUNT(*)::int AS "approvedCheckIns" FROM check_in WHERE status='approved' AND checkintime AT TIME ZONE 'UTC'>=$1 AND checkintime AT TIME ZONE 'UTC'<$2`,
            params.slice(0, 2),
          )
        ).rows[0];
        const compliance = (
          await db.query(
            `SELECT COUNT(*) FILTER(WHERE status='active')::int AS "activeAccounts",COUNT(*) FILTER(WHERE accessstatus<>'active')::int AS "restrictedAccounts",(SELECT COUNT(*)::int FROM user_certifications WHERE status='active' AND renewaldate<NOW() AT TIME ZONE 'UTC') AS "expiredTraining" FROM "user"`,
          )
        ).rows[0];
        const live = (
          await db.query(
            `SELECT target_kind AS kind,target_id AS "resourceId",COUNT(DISTINCT user_id)::int AS "activeReaderLeases" FROM app_device_access_event WHERE allowed=true AND expires_at>NOW() GROUP BY target_kind,target_id ORDER BY target_kind,target_id`,
          )
        ).rows;
        const usage = (
          await db.query(
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
          notes: [
            "Revenue groups recorded receipts by original purchase date and current refund state; it is not a historical cash-flow ledger.",
            "Booking utilization uses the full selected calendar window, not operating-hours availability. Reader-authorized time is separately measured and is not proof of physical machine operation.",
            "Room visits are historical check-ins, not current headcount. Active reader leases and verified class attendance are reported separately.",
          ],
        };
      });
      if (req.path.endsWith("/export")) {
        const rows = reportLines(data);
        if (req.query.format === "csv") {
          const records: any[] = [
            {
              section: "metadata",
              from,
              to,
              timeZone: tz,
              generatedAt: data.generatedAt,
            },
            ...data.notes.map((note) => ({ section: "method", note })),
          ];
          for (const section of [
            "revenue",
            "equipment",
            "patterns",
            "classes",
            "rooms",
            "live",
            "usage",
          ] as const)
            for (const row of data[section]) records.push({ section, ...row });
          records.push(
            { section: "active", ...data.active },
            { section: "compliance", ...data.compliance },
          );
          const headers = [
            ...new Set(records.flatMap((row) => Object.keys(row))),
          ];
          const content = [
            headers,
            ...records.map((row) =>
              headers.map((key) => String(row[key] ?? "")),
            ),
          ]
            .map((row) => row.map(csvCell).join(","))
            .join("\r\n");
          res.json({
            data: {
              filename: `arbor-report-${from}-${to}.csv`,
              contentType: "text/csv;charset=utf-8",
              encoding: "text",
              content,
            },
          });
        } else if (req.query.format === "pdf") {
          res.json({
            data: {
              filename: `arbor-report-${from}-${to}.pdf`,
              contentType: "application/pdf",
              encoding: "base64",
              content: pdfReport(rows.map((x) => x.join(" | "))).toString(
                "base64",
              ),
            },
          });
        } else throw new AppError(400, "INVALID_FORMAT", "Choose CSV or PDF.");
        return;
      }
      res.json({ data });
    },
  );
  return r;
}
function csvCell(s: string) {
  const safe = /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function reportLines(d: any): string[][] {
  const rows = [
    ["Report", `${d.from} through ${d.to}`, d.timeZone, d.generatedAt],
    ...d.notes.map((x: string) => ["Method", x]),
  ];
  for (const section of [
    "revenue",
    "equipment",
    "patterns",
    "classes",
    "rooms",
    "live",
    "usage",
  ])
    for (const row of d[section])
      rows.push([
        section,
        ...Object.entries(row).map(([k, v]) => `${k}: ${v ?? "not recorded"}`),
      ]);
  for (const section of ["active", "compliance"])
    rows.push([
      section,
      ...Object.entries(d[section]).map(([k, v]) => `${k}: ${v}`),
    ]);
  return rows;
}
export function pdfReport(lines: string[]): Buffer {
  const wrapped = lines.flatMap((line) => {
    const clean = line.replace(/[^\x20-\x7e]/g, " ");
    return clean.match(/.{1,95}/g) ?? [""];
  });
  const pages = [];
  for (let i = 0; i < wrapped.length; i += 47)
    pages.push(wrapped.slice(i, i + 47));
  const objects: string[] = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const ids: number[] = [];
  for (const lines of pages) {
    const id = objects.length + 1,
      contentId = id + 1;
    ids.push(id);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream =
      "BT /F1 9 Tf 36 756 Td 15 TL " +
      lines
        .map(
          (line, i) =>
            (i ? "T* " : "") +
            "(" +
            line
              .replaceAll("\\", "\\\\")
              .replaceAll("(", "\\(")
              .replaceAll(")", "\\)") +
            ") Tj",
        )
        .join("\n") +
      " ET";
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${ids.map((id) => id + " 0 R").join(" ")}] /Count ${ids.length} >>`;
  let out = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
