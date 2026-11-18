import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import type { AppConfig } from "../../src/config.js";

const database = `arbor_health_${randomBytes(6).toString("hex")}_mvc_test`,
  admin = new Pool(),
  pool = new Pool({ database });
const secret = randomBytes(32).toString("hex");
let app: ReturnType<typeof createApp>,
  token: string,
  memberToken: string,
  created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Explicit isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  const config: AppConfig = {
    jwtKey: randomBytes(32),
    port: 8080,
    host: "127.0.0.1",
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: [],
    timeZone: "America/New_York",
    devices: {
      cardHashKey: randomBytes(32).toString("hex"),
      readers: [
        { id: "front", secret, kind: "building" },
        { id: "shop", secret, kind: "building" },
        { id: "legacy", secret, kind: "building" },
      ],
    },
  };
  app = createApp(pool, config);
  token = (await request(app).post("/api/auth/demo").send({ role: "admin" })).body.data.accessToken;
  memberToken = (await request(app).post("/api/auth/demo").send({ role: "member" })).body.data.accessToken;
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

function signed(reader: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ eventId: randomUUID(), ...payload }),
    stamp = String(Date.now());
  return request(app)
    .post("/api/devices/decision")
    .set("Content-Type", "application/json")
    .set("X-Reader-ID", reader)
    .set("X-Reader-Timestamp", stamp)
    .set("X-Reader-Signature", createHmac("sha256", secret).update(stamp + "\n" + body).digest("hex"))
    .send(body);
}
const heartbeat = (reader: string, health?: unknown) =>
  signed(reader, health === undefined ? { action: "heartbeat" } : { action: "heartbeat", health });
const reachable = (change: Record<string, unknown> = {}) => ({
  reader: {
    reachable: true, ready: true, doorState: "locked", rssi: -70, address: "129.21.41.118",
    firmware: "1.8.0-classic-pi", uptimeMs: 600_000, lastContactMs: 120, ...change,
  },
});
const board = async () =>
  (await request(app).get("/api/admin/access/reader-health").set("Authorization", `Bearer ${token}`).expect(200)).body.data;
const detail = async (id: string) =>
  (await request(app).get(`/api/admin/access/reader-health/${id}`).set("Authorization", `Bearer ${token}`).expect(200)).body.data;
const reader = (data: { readers: { id: string }[] }, id: string) => data.readers.find((r) => r.id === id) as any;
// Samples are written on change or once a minute; age them to take the next one.
const ageSamples = (id: string) =>
  pool.query("UPDATE app_reader_health_sample SET sampled_at=sampled_at-INTERVAL '2 minutes' WHERE reader_id=$1", [id]);

test("a heartbeat's health report becomes the reader's status", async () => {
  const reply = await heartbeat("front", reachable()).expect(200);
  assert.equal(reply.body.data.reason, "HEARTBEAT");
  assert.equal(reply.body.data.allowed, false);
  const front = reader(await board(), "front");
  assert.equal(front.status, "working");
  assert.equal(front.health.rssi, -70);
  assert.equal(front.health.firmware, "1.8.0-classic-pi");
  assert.equal(front.since, null);
  assert.equal(reader(await board(), "shop").status, "never_connected");
});

test("an unreachable reader is reported while the gateway stays up, then recovers", async () => {
  await heartbeat("shop", reachable({ rssi: -84 })).expect(200);
  assert.equal(reader(await board(), "shop").status, "weak_signal");
  await ageSamples("shop");
  await pool.query("UPDATE app_access_reader SET last_seen_at=NOW()-INTERVAL '5 minutes' WHERE id='shop'");
  await heartbeat("shop", { reader: { reachable: false, lastContactMs: 21_000 } }).expect(200);
  // The gateway's heartbeat no longer counts as the reader being seen, so the
  // existing outage notices and scan controls see this reader as offline.
  const seen = (await pool.query("SELECT last_seen_at>NOW()-INTERVAL '1 minute' AS fresh FROM app_access_reader WHERE id='shop'")).rows[0];
  assert.equal(seen.fresh, false);
  const listed = (
    await request(app).get("/api/admin/access/readers").set("Authorization", `Bearer ${token}`).expect(200)
  ).body.data.readers.find((r: { id: string }) => r.id === "shop");
  assert.equal(listed.online, false);
  const down = reader(await board(), "shop");
  assert.equal(down.status, "unreachable");
  assert.ok(down.since);
  assert.equal(down.health.reachable, false);
  assert.deepEqual(down.day.segments.at(-1).state, "down");
  // Repeated unreachable reports add no new events.
  await heartbeat("shop", { reader: { reachable: false, lastContactMs: 31_000 } }).expect(200);
  await pool.query("UPDATE app_reader_health_event SET occurred_at=occurred_at-INTERVAL '27 minutes' WHERE reader_id='shop'");
  await heartbeat("shop", reachable({ rssi: -72, address: "129.21.40.212" })).expect(200);
  const back = await detail("shop");
  assert.equal(back.status, "working");
  const kinds = back.activity.map((item: { type: string }) => item.type);
  assert.deepEqual(kinds.filter((kind: string) => kind !== "tap").slice(0, 4).sort(), [
    "address_changed", "reachable", "unreachable", "weak_signal",
  ]);
  const recovered = back.activity.find((item: { type: string }) => item.type === "reachable");
  assert.ok(recovered.detail.outageSeconds >= 27 * 60);
  assert.equal(back.day.dropouts, 1);
  assert.equal(back.signal.length, 96);
});

test("malformed telemetry never costs a heartbeat, and older gateways still show online", async () => {
  const reply = await heartbeat("front", { reader: { reachable: "maybe" } }).expect(200);
  assert.equal(reply.body.data.mode, "access");
  await heartbeat("legacy").expect(200);
  const legacy = reader(await board(), "legacy");
  assert.equal(legacy.status, "online");
  assert.equal(legacy.health, null);
  await heartbeat("front", reachable({ rssi: 40, firmware: "bad value" })).expect(200);
  const front = reader(await board(), "front");
  assert.equal(front.status, "working");
  assert.equal(front.health.rssi, null);
});

test("a gateway that stops reporting is not shown as a working reader", async () => {
  await pool.query(
    "UPDATE app_access_reader SET last_seen_at=NOW()-INTERVAL '5 minutes',health_reported_at=NOW()-INTERVAL '5 minutes' WHERE id='front'",
  );
  const front = reader(await board(), "front");
  assert.equal(front.status, "not_reporting");
  assert.ok(front.since);
  // An old report is never shown as current.
  assert.equal(front.health, null);
  const data = await board();
  assert.equal(data.gateway.total, 3);
  assert.equal(data.gateway.reachable, 1);
});

test("taps appear in the activity and as the last tap", async () => {
  await heartbeat("front", reachable()).expect(200);
  await signed("front", { uid: "04:53:D2:95:22:02:89", renewal: false }).expect(200);
  const front = await detail("front");
  assert.equal(front.lastTap.allowed, false);
  const tap = front.activity.find((item: { type: string }) => item.type === "tap");
  assert.equal(tap.detail.last4, "0289");
});

test("reader health is staff-only", async () => {
  await request(app).get("/api/admin/access/reader-health").set("Authorization", `Bearer ${memberToken}`).expect(403);
  await request(app).get("/api/admin/access/reader-health/nope").set("Authorization", `Bearer ${token}`).expect(404);
  await request(app).get("/api/admin/access/reader-health/front").expect(401);
});

test("a failed telemetry write never costs the heartbeat", async () => {
  await pool.query("ALTER TABLE app_reader_health_sample RENAME TO app_reader_health_sample_hidden");
  try {
    const reply = await heartbeat("front", reachable()).expect(200);
    assert.equal(reply.body.data.mode, "access");
    assert.equal(reply.body.data.reason, "HEARTBEAT");
  } finally {
    await pool.query("ALTER TABLE app_reader_health_sample_hidden RENAME TO app_reader_health_sample");
  }
});
