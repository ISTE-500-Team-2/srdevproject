import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daySegments,
  healthEvents,
  parseHealthReport,
  readerStatus,
  signalSeries,
  type HealthReport,
  type HealthSample,
} from "../src/readerHealth.js";

const NOW = new Date("2026-11-18T20:35:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const report = (change: Partial<HealthReport> = {}): HealthReport => ({
  reachable: true,
  ready: true,
  doorState: "locked",
  rssi: -70,
  address: "129.21.41.118",
  firmware: "1.8.0-classic-pi",
  uptimeMs: 600_000,
  lastContactMs: 0,
  ...change,
});
const sample = (minutesAgo: number, change: Partial<HealthSample> = {}): HealthSample => ({
  sampledAt: ago(minutesAgo),
  reachable: true,
  ready: true,
  rssi: -70,
  address: "129.21.41.118",
  firmware: "1.8.0-classic-pi",
  uptimeMs: 500_000,
  ...change,
});

test("a well-formed report keeps every field", () => {
  assert.deepEqual(
    parseHealthReport({
      reader: {
        reachable: true, ready: true, doorState: "locked", rssi: -78, address: "129.21.41.118",
        firmware: "1.8.0-classic-pi", uptimeMs: 1234, lastContactMs: 412,
      },
    }),
    report({ rssi: -78, uptimeMs: 1234, lastContactMs: 412 }),
  );
});

test("malformed telemetry becomes null instead of failing the heartbeat", () => {
  assert.deepEqual(
    parseHealthReport({
      reader: {
        reachable: true, ready: "yes", doorState: "open", rssi: 12, address: "x; DROP",
        firmware: "has spaces", uptimeMs: -1, lastContactMs: 1.5,
      },
    }),
    {
      reachable: true, ready: null, doorState: null, rssi: null, address: null, firmware: null,
      uptimeMs: null, lastContactMs: null,
    },
  );
  for (const raw of [undefined, null, "health", [], {}, { reader: {} }, { reader: { reachable: "no" } }])
    assert.equal(parseHealthReport(raw), null);
});

test("an unreachable reader carries no current state, only its last contact", () => {
  assert.deepEqual(parseHealthReport({ reader: { reachable: false, ready: true, rssi: -60, lastContactMs: 21_000 } }), {
    reachable: false, ready: null, doorState: null, rssi: null, address: null, firmware: null,
    uptimeMs: null, lastContactMs: 21_000,
  });
});

test("events mark each change once", () => {
  const unreachable = report({ reachable: false, ready: null, rssi: null, address: null, firmware: null, uptimeMs: null });
  assert.deepEqual(healthEvents(sample(1), sample(1), unreachable).map((e) => e.kind), ["unreachable"]);
  assert.deepEqual(healthEvents(sample(1, { reachable: false }), sample(5), unreachable), []);
  assert.deepEqual(healthEvents(null, null, unreachable).map((e) => e.kind), ["unreachable"]);
  assert.deepEqual(healthEvents(sample(1, { reachable: false }), sample(5), report()).map((e) => e.kind), ["reachable"]);
  assert.deepEqual(healthEvents(sample(1), sample(1), report()), []);
  assert.deepEqual(healthEvents(null, null, report()), []);
});

test("address, firmware, restarts, weak signal and reader faults become events", () => {
  const known = sample(1);
  assert.deepEqual(healthEvents(known, known, report({ address: "129.21.40.212" })), [
    { kind: "address_changed", detail: { from: "129.21.41.118", to: "129.21.40.212" } },
  ]);
  assert.deepEqual(healthEvents(known, known, report({ firmware: "1.8.1-classic-pi" })), [
    { kind: "firmware_changed", detail: { from: "1.8.0-classic-pi", to: "1.8.1-classic-pi" } },
  ]);
  assert.deepEqual(healthEvents(known, known, report({ uptimeMs: 4_000 })).map((e) => e.kind), ["restarted"]);
  assert.deepEqual(healthEvents(known, known, report({ rssi: -84 })), [{ kind: "weak_signal", detail: { rssi: -84 } }]);
  assert.deepEqual(healthEvents(known, sample(1, { rssi: -82 }), report({ rssi: -84 })), []);
  assert.deepEqual(healthEvents(known, known, report({ ready: false })).map((e) => e.kind), ["reader_fault"]);
  assert.deepEqual(
    healthEvents(known, sample(1, { ready: false }), report()).map((e) => e.kind),
    ["reader_ready"],
  );
  // Missing values never look like a change.
  assert.deepEqual(healthEvents(known, known, report({ address: null, firmware: null, uptimeMs: null, rssi: null })), []);
});

test("status separates a silent gateway from an unreachable reader", () => {
  const fresh = ago(0.2);
  const status = (change: Partial<Parameters<typeof readerStatus>[0]>) =>
    readerStatus({ enabled: true, lastSeenAt: fresh, health: report(), healthReportedAt: fresh, ...change }, NOW);
  assert.equal(status({}), "working");
  assert.equal(status({ enabled: false }), "disabled");
  assert.equal(status({ lastSeenAt: null, health: null, healthReportedAt: null }), "never_connected");
  assert.equal(status({ lastSeenAt: ago(5), healthReportedAt: ago(5) }), "not_reporting");
  // An unreachable reader no longer refreshes last_seen_at, but its gateway still reports.
  assert.equal(status({ lastSeenAt: ago(30), health: report({ reachable: false }) }), "unreachable");
  assert.equal(status({ lastSeenAt: null, health: report({ reachable: false }) }), "unreachable");
  assert.equal(status({ health: report({ ready: false }) }), "reader_fault");
  assert.equal(status({ health: report({ rssi: -84 }) }), "weak_signal");
  assert.equal(status({ health: report({ rssi: -80 }) }), "working");
  // Older gateways send heartbeats without health; a stale report is not current either.
  assert.equal(status({ health: null, healthReportedAt: null }), "online");
  assert.equal(status({ healthReportedAt: ago(5) }), "online");
  assert.equal(status({ lastSeenAt: ago(5), health: report({ reachable: false }), healthReportedAt: ago(5) }), "not_reporting");
});

test("the uptime counter rolling over is not a restart", () => {
  const wrapEnd = 2 ** 32 - 60_000;
  assert.deepEqual(healthEvents(sample(1, { uptimeMs: wrapEnd }), sample(1, { uptimeMs: wrapEnd }), report({ uptimeMs: 30_000 })), []);
  assert.deepEqual(
    healthEvents(sample(1, { uptimeMs: 2 ** 31 }), sample(1, { uptimeMs: 2 ** 31 }), report({ uptimeMs: 30_000 })).map((e) => e.kind),
    ["restarted"],
  );
});

test("the day strip covers 24 hours, merges runs and shows gaps as unknown", () => {
  const day = daySegments(
    [
      sample(24 * 60 + 30),
      sample(24 * 60 - 1),
      sample(600),
      sample(599, { rssi: -84 }),
      sample(598, { rssi: -84 }),
      sample(80, { reachable: false }),
      sample(79, { reachable: false }),
      sample(50),
      sample(21, { reachable: false }),
    ],
    NOW,
  );
  const states = day.segments.map((segment) => segment.state);
  assert.deepEqual(states, ["unknown", "ok", "unknown", "ok", "degraded", "unknown", "down", "unknown", "ok", "unknown", "down", "unknown"]);
  assert.equal(day.segments[0]?.start, ago(24 * 60).toISOString());
  assert.equal(day.segments.at(-1)?.end, NOW.toISOString());
  for (let index = 1; index < day.segments.length; index += 1)
    assert.equal(day.segments[index]?.start, day.segments[index - 1]?.end);
  assert.equal(day.dropouts, 2);
  assert.equal(day.downMinutes, 6);
});

test("a steady reader is one ok segment with no dropouts", () => {
  const samples = Array.from({ length: 24 * 60 + 2 }, (_, index) => sample(24 * 60 + 1 - index));
  const day = daySegments(samples, NOW);
  assert.deepEqual(day.segments.map((segment) => segment.state), ["ok"]);
  assert.equal(day.dropouts, 0);
});

test("signal is averaged per 15 minutes with gaps left empty", () => {
  const series = signalSeries([sample(14, { rssi: -70 }), sample(13, { rssi: -80 }), sample(2, { rssi: -84 }), sample(30, { rssi: null })], NOW);
  assert.equal(series.length, 96);
  assert.equal(series.at(-1)?.rssi, -78);
  assert.equal(series.at(-2)?.rssi, null);
  assert.equal(series.filter((point) => point.rssi !== null).length, 1);
});
