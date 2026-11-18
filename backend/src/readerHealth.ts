// Reader link health. The gateway reports, inside each signed heartbeat, whether it can reach the
// reader itself; this module records those reports and summarizes them for the staff reader pages.

import { Router } from "express";
import type { Pool } from "pg";
import type { Database } from "./db.js";
import { AppError } from "./domain.js";
import { requirePermission } from "./middleware/permissions.js";
import { readerLastSeen, readerPresenceJoin } from "./readerRegistry.js";

/** Below this signal strength readers start dropping out. */
export const WEAK_SIGNAL_DBM = -80;
/** A heartbeat or report older than this no longer counts as current. */
export const FRESH_MS = 45_000;
/** History is sampled on change, or at least this often while reports arrive. */
export const SAMPLE_INTERVAL_MS = 60_000;
/** A gap between samples longer than this is shown as "no report". */
export const SAMPLE_GAP_MS = 150_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNAL_BUCKET_MS = 15 * 60 * 1000;
const DOOR_STATES = ["locked", "checking", "approved", "denied", "issue"] as const;

export type DoorState = (typeof DOOR_STATES)[number];
export type HealthReport = {
  reachable: boolean;
  ready: boolean | null;
  doorState: DoorState | null;
  rssi: number | null;
  address: string | null;
  firmware: string | null;
  uptimeMs: number | null;
  lastContactMs: number | null;
};
export type HealthSample = {
  sampledAt: Date;
  reachable: boolean;
  ready: boolean | null;
  rssi: number | null;
  address: string | null;
  firmware: string | null;
  uptimeMs: number | null;
};
export type HealthEventKind =
  | "unreachable"
  | "reachable"
  | "address_changed"
  | "firmware_changed"
  | "restarted"
  | "weak_signal"
  | "reader_fault"
  | "reader_ready";
export type HealthEvent = { kind: HealthEventKind; detail: Record<string, unknown> };
export type ReaderStatus =
  | "disabled"
  | "never_connected"
  | "not_reporting"
  | "unreachable"
  | "reader_fault"
  | "weak_signal"
  | "working"
  | "online";
export type SegmentState = "ok" | "degraded" | "down" | "unknown";
export type Segment = { state: SegmentState; start: string; end: string };

const int = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;

/**
 * The gateway's report, field by field. Anything malformed becomes null rather than failing the
 * heartbeat: a bad telemetry value must never cost a reader its access decisions.
 */
export function parseHealthReport(raw: unknown): HealthReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = (raw as { reader?: unknown }).reader as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || typeof r.reachable !== "boolean") return null;
  const text = (value: unknown, pattern: RegExp) =>
    typeof value === "string" && pattern.test(value) ? value : null;
  const reachable = r.reachable;
  return {
    reachable,
    // An unreachable reader has no current state; only the gateway's view counts.
    ready: reachable && typeof r.ready === "boolean" ? r.ready : null,
    doorState:
      reachable && DOOR_STATES.includes(r.doorState as DoorState) ? (r.doorState as DoorState) : null,
    rssi: reachable ? int(r.rssi, -127, 0) : null,
    address: reachable ? text(r.address, /^[0-9a-fA-F:.]{2,45}$/) : null,
    firmware: reachable ? text(r.firmware, /^[A-Za-z0-9._+-]{1,64}$/) : null,
    uptimeMs: reachable ? int(r.uptimeMs, 0, 2 ** 32 - 1) : null,
    lastContactMs: int(r.lastContactMs, 0, 2 ** 31 - 1),
  };
}

const weak = (rssi: number | null) => rssi !== null && rssi < WEAK_SIGNAL_DBM;
const UPTIME_WRAP = 2 ** 32, WRAP_MARGIN_MS = 15 * 60_000;
/** The reader's 32-bit millisecond counter rolls over about every 49.7 days. */
const uptimeWrapped = (before: number, after: number) =>
  before > UPTIME_WRAP - WRAP_MARGIN_MS && after < WRAP_MARGIN_MS;

/**
 * Changes worth a line in the reader's activity. `previous` is the latest sample, `known` the latest
 * one taken while the reader was reachable (its values are the last ones anyone saw).
 */
export function healthEvents(
  previous: HealthSample | null,
  known: HealthSample | null,
  report: HealthReport,
): HealthEvent[] {
  const events: HealthEvent[] = [];
  if (!report.reachable) {
    if (!previous || previous.reachable) events.push({ kind: "unreachable", detail: {} });
    return events;
  }
  if (previous && !previous.reachable) events.push({ kind: "reachable", detail: {} });
  if (known?.address && report.address && known.address !== report.address)
    events.push({ kind: "address_changed", detail: { from: known.address, to: report.address } });
  if (known?.firmware && report.firmware && known.firmware !== report.firmware)
    events.push({ kind: "firmware_changed", detail: { from: known.firmware, to: report.firmware } });
  if (known?.uptimeMs != null && report.uptimeMs !== null && report.uptimeMs < known.uptimeMs
      && !uptimeWrapped(known.uptimeMs, report.uptimeMs))
    events.push({ kind: "restarted", detail: {} });
  if (weak(report.rssi) && !weak(known?.rssi ?? null))
    events.push({ kind: "weak_signal", detail: { rssi: report.rssi } });
  if (report.ready === false && known?.ready !== false)
    events.push({ kind: "reader_fault", detail: {} });
  if (report.ready === true && known?.ready === false)
    events.push({ kind: "reader_ready", detail: {} });
  return events;
}

const sampleColumns = `sampled_at AS "sampledAt",reachable,ready,rssi,address,firmware,
  uptime_ms::float8 AS "uptimeMs"`;

/** Record one report, inside the heartbeat transaction that holds the reader row lock. */
export async function recordHealth(db: Database, readerId: string, report: HealthReport) {
  const previous = (
    await db.query<HealthSample & { ageMs: number }>(
      `SELECT ${sampleColumns},EXTRACT(EPOCH FROM NOW()-sampled_at)*1000 AS "ageMs"
       FROM app_reader_health_sample WHERE reader_id=$1 ORDER BY sampled_at DESC LIMIT 1`,
      [readerId],
    )
  ).rows[0] ?? null;
  const known = previous?.reachable
    ? previous
    : (
        await db.query<HealthSample>(
          `SELECT ${sampleColumns} FROM app_reader_health_sample
           WHERE reader_id=$1 AND reachable ORDER BY sampled_at DESC LIMIT 1`,
          [readerId],
        )
      ).rows[0] ?? null;
  const events = healthEvents(previous, known, report);
  for (const event of events) {
    if (event.kind === "reachable") {
      const lost = (
        await db.query<{ seconds: number }>(
          `SELECT EXTRACT(EPOCH FROM NOW()-occurred_at)::int AS seconds FROM app_reader_health_event
           WHERE reader_id=$1 AND kind='unreachable' ORDER BY occurred_at DESC LIMIT 1`,
          [readerId],
        )
      ).rows[0];
      if (lost) event.detail.outageSeconds = lost.seconds;
    }
    await db.query(
      "INSERT INTO app_reader_health_event(reader_id,kind,detail) VALUES($1,$2,$3)",
      [readerId, event.kind, event.detail],
    );
  }
  const due =
    !previous ||
    events.length > 0 ||
    previous.reachable !== report.reachable ||
    previous.ready !== report.ready ||
    weak(previous.rssi) !== weak(report.rssi) ||
    Number(previous.ageMs) >= SAMPLE_INTERVAL_MS;
  if (due) {
    await db.query(
      `INSERT INTO app_reader_health_sample(reader_id,reachable,ready,door_state,rssi,address,firmware,uptime_ms,last_contact_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [readerId, report.reachable, report.ready, report.doorState, report.rssi, report.address,
        report.firmware, report.uptimeMs, report.lastContactMs],
    );
    await db.query(
      "DELETE FROM app_reader_health_sample WHERE reader_id=$1 AND sampled_at<NOW()-INTERVAL '8 days'",
      [readerId],
    );
    await db.query(
      "DELETE FROM app_reader_health_event WHERE reader_id=$1 AND occurred_at<NOW()-INTERVAL '90 days'",
      [readerId],
    );
  }
  await db.query("UPDATE app_access_reader SET health=$2,health_reported_at=NOW() WHERE id=$1", [
    readerId,
    report,
  ]);
}

/** What staff should see for a reader right now. */
export function readerStatus(
  reader: {
    enabled: boolean;
    lastSeenAt: Date | null;
    health: HealthReport | null;
    healthReportedAt: Date | null;
  },
  now: Date,
): ReaderStatus {
  if (!reader.enabled) return "disabled";
  const report = reader.health;
  // A current report from the gateway says what the reader is doing.
  if (report && isFresh(reader.healthReportedAt, now)) {
    if (!report.reachable) return "unreachable";
    if (report.ready === false) return "reader_fault";
    if (weak(report.rssi)) return "weak_signal";
    return "working";
  }
  // A gateway that predates health reports only proves the reader is up.
  if (isFresh(reader.lastSeenAt, now)) return "online";
  if (!reader.lastSeenAt && !reader.healthReportedAt) return "never_connected";
  return "not_reporting";
}

export const isFresh = (at: Date | null, now: Date) => !!at && now.getTime() - at.getTime() < FRESH_MS;
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

const segmentState = (sample: HealthSample): SegmentState =>
  !sample.reachable ? "down" : sample.ready === false || weak(sample.rssi) ? "degraded" : "ok";

/**
 * The last day as contiguous segments. `samples` are ascending and may start with the last sample
 * before the window. A sample counts until the next one, or for SAMPLE_GAP_MS when none follows.
 */
export function daySegments(samples: HealthSample[], now: Date, windowMs = DAY_MS) {
  const end = now.getTime(),
    from = end - windowMs;
  const raw: { state: SegmentState; start: number; end: number }[] = [];
  const push = (state: SegmentState, start: number, stop: number) => {
    if (stop <= start) return;
    const last = raw[raw.length - 1];
    if (last && last.state === state && last.end === start) last.end = stop;
    else raw.push({ state, start, end: stop });
  };
  let cursor = from;
  samples.forEach((sample, index) => {
    const at = sample.sampledAt.getTime();
    const next = samples[index + 1]?.sampledAt.getTime() ?? end;
    const covered = Math.min(next, at + SAMPLE_GAP_MS, end);
    if (covered <= from) return;
    const start = Math.max(at, from);
    push("unknown", cursor, start);
    push(segmentState(sample), start, covered);
    cursor = Math.max(cursor, covered);
  });
  push("unknown", cursor, end);
  const down = raw.filter((segment) => segment.state === "down");
  return {
    segments: raw.map((segment) => ({
      state: segment.state,
      start: new Date(segment.start).toISOString(),
      end: new Date(segment.end).toISOString(),
    })),
    dropouts: down.filter((segment) => segment.start > from).length,
    downMinutes: Math.round(down.reduce((sum, segment) => sum + segment.end - segment.start, 0) / 60_000),
  };
}

/** Average signal per 15 minutes over the last day; null where nothing was reported. */
export function signalSeries(samples: HealthSample[], now: Date, windowMs = DAY_MS) {
  const end = now.getTime(),
    from = end - windowMs,
    buckets = Math.ceil(windowMs / SIGNAL_BUCKET_MS);
  const sums = Array.from({ length: buckets }, () => ({ total: 0, count: 0 }));
  for (const sample of samples) {
    const at = sample.sampledAt.getTime();
    if (sample.rssi === null || at < from || at > end) continue;
    const bucket = sums[Math.min(buckets - 1, Math.floor((at - from) / SIGNAL_BUCKET_MS))];
    if (!bucket) continue;
    bucket.total += sample.rssi;
    bucket.count += 1;
  }
  return sums.map((bucket, index) => ({
    at: new Date(from + index * SIGNAL_BUCKET_MS).toISOString(),
    rssi: bucket.count ? Math.round(bucket.total / bucket.count) : null,
  }));
}

type ReaderRow = {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date | null;
  health: HealthReport | null;
  healthReportedAt: Date | null;
};

async function summaries(db: Database, readerId: string | null) {
  const readers = (
    await db.query<ReaderRow>(
      `SELECT r.id,r.name,r.enabled,${readerLastSeen} AS "lastSeenAt",r.health,
         r.health_reported_at AS "healthReportedAt"
       FROM app_access_reader r ${readerPresenceJoin}
       WHERE $1::text IS NULL OR r.id=$1 ORDER BY r.name,r.id`,
      [readerId],
    )
  ).rows;
  if (readerId && !readers.length) throw new AppError(404, "NOT_FOUND", "Reader not found.");
  const ids = readers.map((reader) => reader.id);
  const samples = (
    await db.query<HealthSample & { readerId: string }>(
      `SELECT reader_id AS "readerId",${sampleColumns} FROM (
         SELECT DISTINCT ON (reader_id) * FROM app_reader_health_sample
         WHERE reader_id=ANY($1) AND sampled_at<=NOW()-INTERVAL '24 hours'
         ORDER BY reader_id,sampled_at DESC) earlier
       UNION ALL
       SELECT reader_id AS "readerId",${sampleColumns} FROM app_reader_health_sample
       WHERE reader_id=ANY($1) AND sampled_at>NOW()-INTERVAL '24 hours'
       ORDER BY "readerId","sampledAt"`,
      [ids],
    )
  ).rows;
  const since = (
    await db.query<{ readerId: string; occurredAt: Date }>(
      `SELECT DISTINCT ON (reader_id) reader_id AS "readerId",occurred_at AS "occurredAt"
       FROM app_reader_health_event WHERE reader_id=ANY($1) AND kind='unreachable'
       ORDER BY reader_id,occurred_at DESC`,
      [ids],
    )
  ).rows;
  const taps = (
    await db.query<{ readerId: string; at: Date; allowed: boolean; reason: string }>(
      `SELECT DISTINCT ON (reader_id) reader_id AS "readerId",created_at AS at,allowed,reason
       FROM app_device_access_event WHERE reader_id=ANY($1) AND is_tap
       ORDER BY reader_id,created_at DESC`,
      [ids],
    )
  ).rows;
  const clock = (await db.query<{ now: Date }>("SELECT NOW() AS now")).rows[0];
  if (!clock) throw new AppError(500, "CLOCK_UNAVAILABLE", "Reader health is unavailable.");
  const now = clock.now;
  return {
    now,
    samples,
    readers: readers.map((reader) => {
      const status = readerStatus(reader, now);
      const own = samples.filter((sample) => sample.readerId === reader.id);
      const lastTap = taps.find((tap) => tap.readerId === reader.id);
      return {
        id: reader.id,
        name: reader.name,
        status,
        since:
          status === "unreachable"
            ? (since.find((event) => event.readerId === reader.id)?.occurredAt ?? reader.healthReportedAt)
            : status === "not_reporting"
              ? later(reader.lastSeenAt, reader.healthReportedAt)
              : null,
        // Never show an old report as current, whatever the status.
        health: isFresh(reader.healthReportedAt, now) ? reader.health : null,
        lastReport: reader.healthReportedAt,
        lastSeenAt: reader.lastSeenAt,
        lastTap: lastTap ? { at: lastTap.at, allowed: lastTap.allowed, reason: lastTap.reason } : null,
        day: daySegments(own, now),
      };
    }),
  };
}

export function readerHealthRoutes(pool: Pool) {
  const routes = Router(),
    read = requirePermission(pool, "user", "read");
  routes.get("/admin/access/reader-health", read, async (_req, res) => {
    const { now, readers } = await summaries(pool, null);
    const enabled = readers.filter((reader) => reader.status !== "disabled");
    const lastHeartbeat = readers.reduce<Date | null>(
      (latest, reader) => later(latest, later(reader.lastSeenAt, reader.lastReport)),
      null,
    );
    res.json({
      data: {
        generatedAt: now,
        readers,
        gateway: {
          lastHeartbeatAt: lastHeartbeat,
          reporting: enabled.filter((reader) => !["not_reporting", "never_connected"].includes(reader.status)).length,
          reachable: enabled.filter((reader) => ["working", "weak_signal", "reader_fault"].includes(reader.status)).length,
          total: enabled.length,
        },
      },
    });
  });
  routes.get("/admin/access/reader-health/:id", read, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new AppError(404, "NOT_FOUND", "Reader not found.");
    const { now, readers, samples } = await summaries(pool, id);
    const events = (
      await pool.query<{ at: Date; kind: HealthEventKind; detail: Record<string, unknown> }>(
        `SELECT occurred_at AS at,kind,detail FROM app_reader_health_event
         WHERE reader_id=$1 ORDER BY occurred_at DESC LIMIT 30`,
        [id],
      )
    ).rows;
    const taps = (
      await pool.query<{ at: Date; allowed: boolean; reason: string; last4: string | null }>(
        `SELECT created_at AS at,allowed,reason,uid_last4 AS last4 FROM app_device_access_event
         WHERE reader_id=$1 AND is_tap ORDER BY created_at DESC LIMIT 30`,
        [id],
      )
    ).rows;
    const activity = [
      ...events.map((event) => ({ type: event.kind, at: event.at, detail: event.detail })),
      ...taps.map((tap) => ({
        type: "tap" as const,
        at: tap.at,
        detail: { allowed: tap.allowed, reason: tap.reason, last4: tap.last4 },
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 30);
    // What the reader last reported about itself, for when it is unreachable now.
    const lastKnown = (
      await pool.query<{ at: Date; ready: boolean | null; rssi: number | null; address: string | null; firmware: string | null }>(
        `SELECT sampled_at AS at,ready,rssi,address,firmware FROM app_reader_health_sample
         WHERE reader_id=$1 AND reachable ORDER BY sampled_at DESC LIMIT 1`,
        [id],
      )
    ).rows[0] ?? null;
    res.json({ data: { ...readers[0], signal: signalSeries(samples, now), activity, lastKnown } });
  });
  return routes;
}
