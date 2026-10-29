import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import type { AppConfig } from "../../src/config.js";

const database = `arbor_setup_${randomBytes(6).toString("hex")}_mvc_test`,
  admin = new Pool(),
  pool = new Pool({ database });
const gatewaySecret = "g".repeat(64),
  otherSecret = "o".repeat(64),
  wifiPassword = "private-wifi-never-in-browser-responses";
let app: ReturnType<typeof createApp>,
  config: AppConfig,
  token: string,
  member: string,
  csrf: string,
  created = false,
  sequence = 0;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Explicit isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  config = {
    jwtKey: randomBytes(32),
    port: 8080,
    host: "127.0.0.1",
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: [],
    timeZone: "America/New_York",
    devices: {
      cardHashKey: randomBytes(32).toString("hex"),
      readers: [],
      setupGateways: [
        { id: "pi", name: "Orange Pi", secret: gatewaySecret },
        { id: "other", name: "Other Pi", secret: otherSecret },
      ],
    },
  };
  app = createApp(pool, config);
  const a = (await request(app).post("/api/auth/demo").send({ role: "admin" }))
    .body.data;
  token = a.accessToken;
  csrf = a.csrfToken;
  member = (await request(app).post("/api/auth/demo").send({ role: "member" }))
    .body.data.accessToken;
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});
function get(path = "/admin/access/reader-setup", auth = token) {
  return request(app)
    .get("/api" + path)
    .set("Authorization", "Bearer " + auth);
}
function post(path: string, body: unknown, auth = token, csrfValue = csrf) {
  return request(app)
    .post("/api" + path)
    .set("Authorization", "Bearer " + auth)
    .set("X-CSRF-Token", csrfValue)
    .send(body);
}
const reportStamps = new Map<string, number>();
function report(
  devices: any[] = [],
  updates: any[] = [],
  options: { id?: string; key?: string; eventId?: string; stamp?: string } = {},
) {
  const id = options.id ?? "pi",
    key = options.key ?? gatewaySecret,
    stamp =
      options.stamp ??
      String(Math.max(Date.now(), (reportStamps.get(id) ?? 0) + 1));
  if (!options.stamp) reportStamps.set(id, Number(stamp));
  const raw = JSON.stringify({
    eventId: options.eventId ?? randomUUID(),
    devices,
    updates,
  });
  return request(app)
    .post("/api/devices/setup/poll")
    .set("Content-Type", "application/json")
    .set("X-Gateway-ID", id)
    .set("X-Gateway-Timestamp", stamp)
    .set(
      "X-Gateway-Signature",
      createHmac("sha256", key)
        .update(stamp + "\n" + raw)
        .digest("hex"),
    )
    .send(raw);
}
function heartbeat(id: string, key: string) {
  const stamp = String(Date.now()),
    raw = JSON.stringify({ action: "heartbeat", eventId: randomUUID() });
  return request(app)
    .post("/api/devices/decision")
    .set("Content-Type", "application/json")
    .set("X-Reader-ID", id)
    .set("X-Reader-Timestamp", stamp)
    .set(
      "X-Reader-Signature",
      createHmac("sha256", key)
        .update(stamp + "\n" + raw)
        .digest("hex"),
    )
    .send(raw);
}
async function device(transport = "usb") {
  const d = {
    id:
      (transport === "usb" ? "usb-" : "net-") +
      (++sequence).toString(16).padStart(24, "0"),
    model: "ESP32-C3 mini",
    firmware: "1.7.1-c3-checkin",
    transport,
  };
  assert.equal((await report([d])).status, 200);
  return d;
}
const details = (d: any) => ({
  gatewayId: "pi",
  deviceId: d.id,
  name: "Workshop mini",
  kind: "building",
  resourceId: 1,
  ssid: "Workshop Wi-Fi",
  password: wifiPassword,
  reason: "Install additional reader",
});
async function start(d: any) {
  const r = await post("/admin/access/reader-setup", details(d));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test("only dedicated gateway authentication can publish discovery; timestamp and replay guards apply", async () => {
  const d = { id: "usb-" + "f".repeat(24), model: "Reader", transport: "usb" };
  assert.equal(
    (await report([d], [], { key: "wrong".repeat(10) })).status,
    401,
  );
  assert.equal((await report([d], [], { id: "unconfigured" })).status, 401);
  assert.equal(
    (await report([d], [], { stamp: String(Date.now() - 30000) })).status,
    401,
  );
  const eventId = randomUUID();
  assert.equal((await report([d], [], { eventId })).status, 200);
  assert.equal((await report([d], [], { eventId })).status, 409);
  assert.equal(
    (await report([{ ...d, id: "../../not-a-device" }])).status,
    400,
  );
  assert.equal((await get(undefined, member)).status, 403);
  assert.equal(
    (await request(app).get("/api/admin/access/reader-setup")).status,
    401,
  );
});
test("discovery is fresh, distinguishes USB/network hints and never exposes gateway credentials", async () => {
  const d = await device(),
    network = await device("network");
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.gateways[0].online, true);
  assert.equal(
    r.body.data.devices.find((v: any) => v.id === d.id).connected,
    true,
  );
  assert.ok(!JSON.stringify(r.body).includes(gatewaySecret));
  assert.equal(
    (await post("/admin/access/reader-setup", details(network))).body.error
      .code,
    "USB_REQUIRED",
  );
  await pool.query(
    "UPDATE app_reader_setup_device SET last_seen_at=NOW()-INTERVAL '1 minute' WHERE device_id=$1",
    [d.id],
  );
  assert.equal(
    (await post("/admin/access/reader-setup", details(d))).body.error.code,
    "DEVICE_DISCONNECTED",
  );
});
test("setup requires permission/CSRF and validates credentials without putting secrets into replies or audit", async () => {
  const d = await device();
  assert.equal(
    (await post("/admin/access/reader-setup", details(d), member)).status,
    403,
  );
  assert.equal(
    (await post("/admin/access/reader-setup", details(d), token, "bad")).status,
    403,
  );
  assert.equal(
    (
      await post("/admin/access/reader-setup", {
        ...details(d),
        ssid: "bad\nnetwork",
      })
    ).status,
    400,
  );
  const job = await start(d);
  assert.ok(job.id && job.readerId);
  assert.ok(!("secret" in job));
  const stored = (
    await pool.query("SELECT * FROM app_reader_setup_job WHERE id=$1", [job.id])
  ).rows[0];
  assert.ok(!stored.payload_encrypted.includes(wifiPassword));
  assert.equal(
    (
      await pool.query("SELECT enabled FROM app_access_reader WHERE id=$1", [
        job.readerId,
      ])
    ).rows[0].enabled,
    false,
  );
  assert.ok(
    !(await get("/admin/access/readers")).body.data.readers.some(
      (r: any) => r.id === job.readerId,
    ),
  );
  const poll = await report([d]);
  const command = poll.body.data.jobs.find((j: any) => j.id === job.id);
  assert.equal(command.password, wifiPassword);
  assert.equal(command.readerSecret.length, 64);
  const visible = JSON.stringify((await get()).body);
  assert.ok(
    !visible.includes(wifiPassword) && !visible.includes(command.readerSecret),
  );
  const audit = JSON.stringify(
    (
      await pool.query(
        "SELECT before_state,after_state FROM app_staff_audit WHERE action='access.reader_setup_started'",
      )
    ).rows,
  );
  assert.ok(
    !audit.includes(wifiPassword) && !audit.includes(command.readerSecret),
  );
  const other = await report([], [], { id: "other", key: otherSecret });
  assert.equal(other.body.data.jobs.length, 0);
});
test("concurrent starts produce one reader/job for the physical device, without consuming cards or check-ins", async () => {
  const d = await device(),
    before = (
      await pool.query(
        "SELECT (SELECT count(*) FROM app_access_card) cards,(SELECT count(*) FROM check_in) visits",
      )
    ).rows[0];
  const results = await Promise.all([
    post("/admin/access/reader-setup", details(d)),
    post("/admin/access/reader-setup", details(d)),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM app_access_card) cards,(SELECT count(*) FROM check_in) visits",
      )
    ).rows[0],
    before,
  );
});
test("completion requires the new reader credential, a fresh real heartbeat and PN532 readiness", async () => {
  const d = await device(),
    job = await start(d),
    command = (await report([d])).body.data.jobs.find(
      (j: any) => j.id === job.id,
    );
  assert.equal(
    (await report([d], [{ id: job.id, status: "complete", readerReady: true }]))
      .status,
    409,
  );
  assert.equal(
    (await heartbeat(job.readerId, "incorrect".repeat(8))).status,
    401,
  );
  const h = await heartbeat(job.readerId, command.readerSecret);
  assert.equal(h.body.data.mode, "disabled");
  assert.equal(h.body.data.allowed, false);
  assert.equal(
    (
      await report(
        [d],
        [{ id: job.id, status: "complete", readerReady: false }],
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await report(
        [],
        [{ id: job.id, status: "complete", readerReady: true }],
        { id: "other", key: otherSecret },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await pool.query("SELECT enabled FROM app_access_reader WHERE id=$1", [
        job.readerId,
      ])
    ).rows[0].enabled,
    false,
  );
  assert.equal(
    (await report([d], [{ id: job.id, status: "complete", readerReady: true }]))
      .status,
    200,
  );
  const row = (
    await pool.query(
      "SELECT enabled,revision FROM app_access_reader WHERE id=$1",
      [job.readerId],
    )
  ).rows[0];
  assert.equal(row.enabled, true);
  assert.equal(row.revision, 2);
  assert.equal(
    (await heartbeat(job.readerId, command.readerSecret)).body.data.mode,
    "access",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT payload_encrypted FROM app_reader_setup_job WHERE id=$1",
        [job.id],
      )
    ).rows[0].payload_encrypted,
    null,
  );
  assert.ok(!(await get()).body.data.devices.some((v: any) => v.id === d.id));
});
test("cancel is idempotent, clears Wi-Fi payload, and late completion cannot re-enable the reader", async () => {
  const d = await device(),
    job = await start(d),
    command = (await report([d])).body.data.jobs.find(
      (j: any) => j.id === job.id,
    );
  await heartbeat(job.readerId, command.readerSecret);
  assert.equal(
    (await post(`/admin/access/reader-setup/${job.id}/cancel`, {})).status,
    200,
  );
  assert.equal(
    (await post(`/admin/access/reader-setup/${job.id}/cancel`, {})).status,
    200,
  );
  assert.equal(
    (await report([d], [{ id: job.id, status: "complete", readerReady: true }]))
      .status,
    200,
  );
  assert.equal(
    (await heartbeat(job.readerId, command.readerSecret)).body.data.mode,
    "disabled",
  );
  const row = (
    await pool.query(
      "SELECT status,payload_encrypted FROM app_reader_setup_job WHERE id=$1",
      [job.id],
    )
  ).rows[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.payload_encrypted, null);
  const audits = await pool.query(
    "SELECT 1 FROM app_staff_audit WHERE action='access.reader_setup_cancelled' AND after_state->>'id'=$1",
    [job.readerId],
  );
  assert.equal(audits.rowCount, 1);
  await report(
    [d],
    [{ id: job.id, status: "failed", errorCode: "recovery_required" }],
  );
  assert.equal(
    (await get()).body.data.jobs.find((j: any) => j.id === job.id).errorCode,
    "recovery_required",
  );
});
test("expiry and worker failure retain disabled readers; completed setup cannot undo a later staff edit", async () => {
  const d = await device(),
    job = await start(d);
  await pool.query(
    "UPDATE app_reader_setup_job SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [job.id],
  );
  const poll = await report(
    [d],
    [{ id: job.id, status: "complete", readerReady: true }],
  );
  assert.equal(
    poll.body.data.jobs.find((j: any) => j.id === job.id).status,
    "expired",
  );
  assert.equal(
    (
      await pool.query("SELECT enabled FROM app_access_reader WHERE id=$1", [
        job.readerId,
      ])
    ).rows[0].enabled,
    false,
  );
  const failed = await start(d);
  await report(
    [d],
    [{ id: failed.id, status: "failed", errorCode: "wifi_failed" }],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT payload_encrypted FROM app_reader_setup_job WHERE id=$1",
        [failed.id],
      )
    ).rows[0].payload_encrypted,
    null,
  );
  const changed = await start(d),
    command = (await report([d])).body.data.jobs.find(
      (j: any) => j.id === changed.id,
    );
  await heartbeat(changed.readerId, command.readerSecret);
  await pool.query(
    "UPDATE app_access_reader SET enabled=false,revision=revision+1 WHERE id=$1",
    [changed.readerId],
  );
  const late = await report(
    [d],
    [{ id: changed.id, status: "complete", readerReady: true }],
  );
  assert.equal(late.status, 200);
  assert.equal(
    late.body.data.jobs.find((j: any) => j.id === changed.id).status,
    "failed",
  );
  assert.equal(
    (
      await pool.query("SELECT enabled FROM app_access_reader WHERE id=$1", [
        changed.readerId,
      ])
    ).rows[0].enabled,
    false,
  );
});
