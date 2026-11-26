// Reader link health rows: the latest report on each reader (app_access_reader.health), its
// sampled history (app_reader_health_sample) and changes worth a line (app_reader_health_event).

import type { Database } from "../../db.js";
import type { HealthEventKind, HealthReport, HealthSample } from "../../readerHealth.js";
import { readerLastSeen, readerPresenceJoin } from "../../readerRegistry.js";

const sampleColumns = `sampled_at AS "sampledAt",reachable,ready,rssi,address,firmware,
  uptime_ms::float8 AS "uptimeMs"`;

export type ReaderRow = {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date | null;
  health: HealthReport | null;
  healthReportedAt: Date | null;
};

/** Recording gateway reports and reading them back for the staff reader pages. */
export class ReaderHealthRepository {
  constructor(private db: Database) {}
  async latestSample(readerId: string) {
    return (
      await this.db.query<HealthSample & { ageMs: number }>(
        `SELECT ${sampleColumns},EXTRACT(EPOCH FROM NOW()-sampled_at)*1000 AS "ageMs"
       FROM app_reader_health_sample WHERE reader_id=$1 ORDER BY sampled_at DESC LIMIT 1`,
        [readerId],
      )
    ).rows[0] ?? null;
  }
  async latestReachableSample(readerId: string) {
    return (
      await this.db.query<HealthSample>(
        `SELECT ${sampleColumns} FROM app_reader_health_sample
           WHERE reader_id=$1 AND reachable ORDER BY sampled_at DESC LIMIT 1`,
        [readerId],
      )
    ).rows[0] ?? null;
  }
  /** Seconds since the reader was last reported unreachable, if ever. */
  async lastOutage(readerId: string) {
    return (
      await this.db.query<{ seconds: number }>(
        `SELECT EXTRACT(EPOCH FROM NOW()-occurred_at)::int AS seconds FROM app_reader_health_event
           WHERE reader_id=$1 AND kind='unreachable' ORDER BY occurred_at DESC LIMIT 1`,
        [readerId],
      )
    ).rows[0];
  }
  async addEvent(readerId: string, kind: HealthEventKind, detail: Record<string, unknown>) {
    await this.db.query(
      "INSERT INTO app_reader_health_event(reader_id,kind,detail) VALUES($1,$2,$3)",
      [readerId, kind, detail],
    );
  }
  async addSample(readerId: string, report: HealthReport) {
    await this.db.query(
      `INSERT INTO app_reader_health_sample(reader_id,reachable,ready,door_state,rssi,address,firmware,uptime_ms,last_contact_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [readerId, report.reachable, report.ready, report.doorState, report.rssi, report.address,
        report.firmware, report.uptimeMs, report.lastContactMs],
    );
  }
  async pruneSamples(readerId: string) {
    await this.db.query(
      "DELETE FROM app_reader_health_sample WHERE reader_id=$1 AND sampled_at<NOW()-INTERVAL '8 days'",
      [readerId],
    );
  }
  async pruneEvents(readerId: string) {
    await this.db.query(
      "DELETE FROM app_reader_health_event WHERE reader_id=$1 AND occurred_at<NOW()-INTERVAL '90 days'",
      [readerId],
    );
  }
  async saveReport(readerId: string, report: HealthReport) {
    await this.db.query("UPDATE app_access_reader SET health=$2,health_reported_at=NOW() WHERE id=$1", [
      readerId,
      report,
    ]);
  }

  /** One reader, or (with null) every reader the board lists. */
  async readers(readerId: string | null) {
    return (
      await this.db.query<ReaderRow>(
        `SELECT r.id,r.name,r.enabled,${readerLastSeen} AS "lastSeenAt",r.health,
         r.health_reported_at AS "healthReportedAt"
       FROM app_access_reader r ${readerPresenceJoin}
       -- The board matches the reader list, which hides readers mid-setup; a
       -- reader's own page still loads while its setup finishes.
       WHERE ($1::text IS NULL AND NOT EXISTS (
           SELECT 1 FROM app_reader_setup_job j WHERE j.reader_id=r.id AND j.status<>'complete'))
         OR r.id=$1
       ORDER BY r.name,r.id`,
        [readerId],
      )
    ).rows;
  }
  /** The last day's samples per reader, ascending, led by the last one before the day began. */
  async daySamples(ids: string[]) {
    return (
      await this.db.query<HealthSample & { readerId: string }>(
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
  }
  /** When each reader was last reported unreachable. */
  async lastOutages(ids: string[]) {
    return (
      await this.db.query<{ readerId: string; occurredAt: Date }>(
        `SELECT DISTINCT ON (reader_id) reader_id AS "readerId",occurred_at AS "occurredAt"
       FROM app_reader_health_event WHERE reader_id=ANY($1) AND kind='unreachable'
       ORDER BY reader_id,occurred_at DESC`,
        [ids],
      )
    ).rows;
  }
  async lastTaps(ids: string[]) {
    return (
      await this.db.query<{ readerId: string; at: Date; allowed: boolean; reason: string }>(
        `SELECT DISTINCT ON (reader_id) reader_id AS "readerId",created_at AS at,allowed,reason
       FROM app_device_access_event WHERE reader_id=ANY($1) AND is_tap
       ORDER BY reader_id,created_at DESC`,
        [ids],
      )
    ).rows;
  }
  async clock() {
    return (await this.db.query<{ now: Date }>("SELECT NOW() AS now")).rows[0];
  }
  async doorLight(id: string) {
    return (
      await this.db.query<{ health: HealthReport | null; healthReportedAt: Date | null }>(
        `SELECT health,health_reported_at AS "healthReportedAt" FROM app_access_reader WHERE id=$1`,
        [id],
      )
    ).rows[0];
  }
  async recentEvents(id: string) {
    return (
      await this.db.query<{ at: Date; kind: HealthEventKind; detail: Record<string, unknown> }>(
        `SELECT occurred_at AS at,kind,detail FROM app_reader_health_event
         WHERE reader_id=$1 ORDER BY occurred_at DESC LIMIT 30`,
        [id],
      )
    ).rows;
  }
  async recentTaps(id: string) {
    return (
      await this.db.query<{ at: Date; allowed: boolean; reason: string; last4: string | null }>(
        `SELECT created_at AS at,allowed,reason,uid_last4 AS last4 FROM app_device_access_event
         WHERE reader_id=$1 AND is_tap ORDER BY created_at DESC LIMIT 30`,
        [id],
      )
    ).rows;
  }
  /** What the reader last reported about itself, for when it is unreachable now. */
  async lastKnown(id: string) {
    return (
      await this.db.query<{ at: Date; ready: boolean | null; rssi: number | null; address: string | null; firmware: string | null }>(
        `SELECT sampled_at AS at,ready,rssi,address,firmware FROM app_reader_health_sample
         WHERE reader_id=$1 AND reachable ORDER BY sampled_at DESC LIMIT 1`,
        [id],
      )
    ).rows[0] ?? null;
  }
}
