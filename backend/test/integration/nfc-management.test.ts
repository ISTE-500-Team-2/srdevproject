import { waiverAcceptance } from "../helpers/waiver.js";
import { SessionModel } from "../../src/models/SessionModel.js";
import { UserModel } from "../../src/models/UserModel.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { compactReaderRenewals } from "../../src/readerLeaseCompaction.js";
import type { AppConfig } from "../../src/config.js";

const database = `arbor_nfc_${randomBytes(6).toString("hex")}_mvc_test`;
const admin = new Pool(),
  pool = new Pool({ database });
const secret = randomBytes(32).toString("hex"),
  hashKey = randomBytes(32).toString("hex");
let app: ReturnType<typeof createApp>,
  config: AppConfig,
  token: string,
  staffToken: string,
  memberToken: string,
  memberId: number,
  otherId: number,
  actorId: number;
let created = false;
const csrf = new Map<string, string>();
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
      cardHashKey: hashKey,
      readers: [
        { id: "front", secret, kind: "building" },
        { id: "back", secret, kind: "building" },
      ],
    },
  };
  app = createApp(pool, config);
  const login = async (role: string) =>
    (await request(app).post("/api/auth/demo").send({ role })).body.data;
  const a = await login("admin"),
    m = await login("member");
  for (const session of [a, m])
    csrf.set(session.accessToken, session.csrfToken);
  token = a.accessToken;
  actorId = a.user.id;
  memberToken = m.accessToken;
  memberId = m.user.id;
  otherId = await new UserModel(pool).create({
    firstName: "Alex",
    lastName: "NFC",
    email: "alex-nfc@example.invalid",
    phone: "555-0100",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
  await pool.query(
    "INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role='admin' ON CONFLICT DO NOTHING",
    [otherId],
  );
  const other = await new SessionModel(pool, config.jwtKey).create(
    otherId,
    false,
  );
  staffToken = other.token;
  csrf.set(staffToken, other.csrfToken);
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});
function post(path: string, body: string | object, auth = token) {
  return request(app)
    .post("/api" + path)
    .set("Authorization", "Bearer " + auth)
    .set("X-CSRF-Token", csrf.get(auth) ?? "")
    .send(body);
}
function get(path: string, auth = token) {
  return request(app)
    .get("/api" + path)
    .set("Authorization", "Bearer " + auth);
}
function tap(
  uid: string,
  extra: Record<string, unknown> = {},
  reader = "front",
  key = secret,
) {
  const body = JSON.stringify({
      eventId: randomUUID(),
      uid,
      renewal: false,
      ...extra,
    }),
    stamp = String(Date.now());
  return request(app)
    .post("/api/devices/decision")
    .set("Content-Type", "application/json")
    .set("X-Reader-ID", reader)
    .set("X-Reader-Timestamp", stamp)
    .set(
      "X-Reader-Signature",
      createHmac("sha256", key)
        .update(stamp + "\n" + body)
        .digest("hex"),
    )
    .send(body);
}
async function start(
  purpose = "assign",
  readerId = "front",
  userId = memberId,
) {
  const r = await post("/admin/access/enrollments", {
    purpose,
    readerId,
    userId,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function assign(
  uid: string,
  userId = memberId,
  extra: Record<string, unknown> = {},
) {
  return post("/admin/access/cards", {
    uid,
    userId,
    label: "NFC regression card",
    reason: "Verified identity",
    ...extra,
  });
}
async function cancel(id: string) {
  assert.equal(
    (await post(`/admin/access/enrollments/${id}/cancel`, {})).status,
    200,
  );
}

test("setup exposes safe reader names, connection status and a clear unconfigured state", async () => {
  const r = await get("/admin/access/readers");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.configured, true);
  assert.equal(r.body.data.readers.length, 2);
  assert.equal(r.body.data.readers[0].online, false);
  assert.ok(!JSON.stringify(r.body).includes(secret));
  const stored = (
    await pool.query(
      "SELECT secret_encrypted FROM app_access_reader WHERE id='front'",
    )
  ).rows[0].secret_encrypted;
  assert.ok(!stored.includes(secret));
  const bare = createApp(pool, { ...config, devices: undefined });
  const r2 = await request(bare)
    .get("/api/admin/access/readers")
    .set("Authorization", "Bearer " + token);
  assert.equal(r2.body.data.configured, false);
  assert.equal((await get("/admin/access/readers", memberToken)).status, 403);
});
test("unknown taps retain only a fingerprint and suffix and are available in history and lookup", async () => {
  const uid = "AA010203";
  const r = await tap(uid);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reason, "CARD_NOT_ASSIGNED");
  const event = (
    await pool.query("SELECT * FROM app_device_access_event WHERE id=$1", [
      r.body.data.decisionId,
    ])
  ).rows[0];
  assert.equal(event.uid_last4, "0203");
  assert.equal(
    event.uid_hash,
    createHmac("sha256", hashKey).update(uid).digest("hex"),
  );
  assert.equal(event.user_id, null);
  const history = await get(
    "/admin/access/events?result=unknown&readerId=front",
  );
  assert.equal(history.body.data.items[0].id, event.id);
  assert.ok(!JSON.stringify(history.body).includes(event.uid_hash));
  assert.ok(!JSON.stringify(history.body).includes(uid));
  const lookup = await post("/admin/access/cards/lookup", {
    eventId: event.id,
  });
  assert.deepEqual(lookup.body.data, []);
});
test("enrollment captures once, denies access, never checks in and is bound to member and staff actor", async () => {
  const session = await start();
  const heartbeat = await tap("", { action: "heartbeat" });
  assert.equal(heartbeat.body.data.mode, "enroll");
  assert.equal(heartbeat.body.data.allowed, false);
  const before = (await pool.query("SELECT count(*) FROM check_in")).rows[0]
    .count;
  const responses = await Promise.all([
    tap("AA111111", { checkIn: true }),
    tap("AA222222", { checkIn: true }),
  ]);
  assert.equal(
    responses.filter((r) => r.body.data.reason === "ENROLLMENT_CAPTURED")
      .length,
    1,
  );
  assert.ok(
    responses.every(
      (r) => r.body.data.allowed === false && r.body.data.leaseSeconds === 0,
    ),
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM check_in")).rows[0].count,
    before,
  );
  const captured = await get(`/admin/access/enrollments/${session.id}`);
  assert.equal(captured.body.data.status, "captured");
  assert.ok(["1111", "2222"].includes(captured.body.data.last4));
  assert.ok(!JSON.stringify(captured.body).includes("uid_hash"));
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`, staffToken)).status,
    404,
  );
  assert.equal(
    (await assign("", otherId, { enrollmentId: session.id })).status,
    409,
  );
  const saved = await assign("", memberId, { enrollmentId: session.id });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(
    (await assign("", memberId, { enrollmentId: session.id })).status,
    409,
  );
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`)).body.data.status,
    "completed",
  );
});
test("renewal and legacy non-check-in traffic cannot consume enrollment", async () => {
  const session = await start();
  assert.equal(
    (await tap("BB112233", { renewal: true })).body.data.reason,
    "ENROLLMENT_WAITING",
  );
  assert.equal(
    (await tap("BB112233", { renewal: undefined, checkIn: false })).body.data
      .reason,
    "ENROLLMENT_WAITING",
  );
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`)).body.data.status,
    "waiting",
  );
  const captured = await tap("BB112233", { renewal: undefined, checkIn: true });
  assert.equal(captured.body.data.reason, "ENROLLMENT_CAPTURED");
  await cancel(session.id);
});
test("sessions expire, cancel and prevent one staff operation from replacing another", async () => {
  const session = await start();
  assert.equal(
    (
      await post("/admin/access/enrollments", {
        purpose: "assign",
        readerId: "front",
        userId: otherId,
      })
    ).status,
    409,
  );
  await pool.query(
    "UPDATE app_card_enrollment SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [session.id],
  );
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`)).body.data.status,
    "expired",
  );
  assert.equal(
    (await assign("", memberId, { enrollmentId: session.id })).status,
    409,
  );
  const next = await start();
  await cancel(next.id);
  await cancel(next.id);
  assert.equal(
    (await get(`/admin/access/enrollments/${next.id}`)).body.data.status,
    "cancelled",
  );
});
test("revoke, reissue and reactivate preserve history and return the current owner on conflicts", async () => {
  const first = await assign("CC112233");
  assert.equal(first.status, 201);
  const id = first.body.data.id;
  const revoke = () =>
    post(`/admin/access/cards/${id}/revoke`, {
      expectedRevision: 1,
      reason: "Returned card",
    });
  assert.equal((await revoke()).status, 200);
  assert.equal((await revoke()).status, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM app_staff_audit WHERE action='access.card_revoked' AND entity_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  const reissue = await assign("CC112233", otherId);
  assert.equal(reissue.status, 201);
  const denied = await post(`/admin/access/cards/${id}/reactivate`, {
    expectedRevision: 2,
    reason: "Found card",
  });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, "CARD_ALREADY_ASSIGNED");
  const history = await post("/admin/access/cards/lookup", {
    uid: "CC:11:22:33",
  });
  assert.equal(history.body.data.length, 2);
  assert.equal(history.body.data[0].userId, otherId);
  assert.equal(history.body.data[1].active, false);
  await post(`/admin/access/cards/${reissue.body.data.id}/revoke`, {
    expectedRevision: 1,
    reason: "Returned again",
  });
  assert.equal(
    (
      await post(`/admin/access/cards/${id}/reactivate`, {
        expectedRevision: 2,
        reason: "Verified card returned",
      })
    ).status,
    200,
  );
});
test("simultaneous assignments have one owner and an actionable conflict", async () => {
  const results = await Promise.all([
    assign("DD112233"),
    assign("DD112233", otherId),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const conflict = results.find((r) => r.status === 409)!;
  assert.equal(conflict.body.error.code, "CARD_ALREADY_ASSIGNED");
  assert.match(conflict.body.error.message, /already assigned to/);
});
test("replacement is atomic and stale revocations never change data", async () => {
  const old = (await assign("EE112233")).body.data,
    occupied = (await assign("EE445566", otherId)).body.data;
  const conflict = await assign("EE445566", memberId, {
    replaceCardId: old.id,
    expectedRevision: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (
      await pool.query("SELECT active FROM app_access_card WHERE id=$1", [
        old.id,
      ])
    ).rows[0].active,
    true,
  );
  const replacement = await assign("EE778899", memberId, {
    replaceCardId: old.id,
    expectedRevision: 1,
  });
  assert.equal(replacement.status, 201);
  assert.equal(
    (
      await post(`/admin/access/cards/${replacement.body.data.id}/revoke`, {
        expectedRevision: 2,
        reason: "Stale action",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await pool.query("SELECT active FROM app_access_card WHERE id=$1", [
        replacement.body.data.id,
      ])
    ).rows[0].active,
    true,
  );
  assert.ok(occupied.id);
  const cards = await get(`/admin/access/cards?userId=${memberId}`);
  const card = cards.body.data.find(
    (c: any) => c.id === replacement.body.data.id,
  );
  assert.equal(card.last4, "8899");
  assert.ok(card.assignedBy);
  assert.ok("lastUsedAt" in card);
  assert.ok(!JSON.stringify(cards.body).includes("uid_hash"));
});
test("lookup by tapping identifies the current owner and releases the reader", async () => {
  const session = await start("lookup");
  await tap("CC112233");
  const result = (await get(`/admin/access/enrollments/${session.id}`)).body
    .data;
  assert.equal(result.status, "captured");
  assert.equal(result.assignments.find((a: any) => a.active).userId, memberId);
  assert.equal(
    (await tap("", { action: "heartbeat" })).body.data.mode,
    "access",
  );
});
test("reader creation needs no environment entry, persists names and disabling cancels scans", async () => {
  app = createApp(pool, {
    ...config,
    devices: { cardHashKey: hashKey, readers: [] },
  });
  const r = await post("/admin/access/readers", {
    id: "new-front",
    name: "Front door",
    kind: "building",
    resourceId: 1,
    reason: "New reader",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = r.body.data.secret;
  assert.equal(
    (await tap("", { action: "heartbeat" }, "new-front", key)).body.data.mode,
    "access",
  );
  let readers = (await get("/admin/access/readers")).body.data.readers;
  assert.equal(readers.find((r: any) => r.id === "new-front").online, true);
  const session = await start("assign", "new-front");
  const disabled = await request(app)
    .patch("/api/admin/access/readers/new-front")
    .set("Authorization", "Bearer " + token)
    .set("X-CSRF-Token", csrf.get(token)!)
    .send({
      name: "Main entrance",
      enabled: false,
      expectedRevision: 1,
      reason: "Maintenance",
    });
  assert.equal(disabled.status, 200);
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`)).body.data.status,
    "cancelled",
  );
  assert.equal(
    (await tap("CC112233", {}, "new-front", key)).body.data.reason,
    "READER_DISABLED",
  );
  app = createApp(pool, config);
  readers = (await get("/admin/access/readers")).body.data.readers;
  const saved = readers.find((r: any) => r.id === "new-front");
  assert.equal(saved.name, "Main entrance");
  assert.equal(saved.enabled, false);
  assert.ok(!JSON.stringify(readers).includes(key));
  const logs = (
    await pool.query(
      "SELECT before_state,after_state FROM app_staff_audit WHERE action LIKE 'access.reader_%'",
    )
  ).rows;
  assert.ok(!JSON.stringify(logs).includes(key));
});
test("reader mutations and card enrollment require staff permissions and invalid signatures cannot capture", async () => {
  assert.equal(
    (
      await post(
        "/admin/access/enrollments",
        { purpose: "assign", readerId: "front", userId: memberId },
        memberToken,
      )
    ).status,
    403,
  );
  const session = await start();
  assert.equal(
    (await tap("FF112233", {}, "front", "wrong".repeat(10))).status,
    401,
  );
  assert.equal(
    (await get(`/admin/access/enrollments/${session.id}`)).body.data.status,
    "waiting",
  );
  await cancel(session.id);
});
test("repeat override revocation is idempotent and duration is bounded server-side", async () => {
  const equipment = (
    await pool.query(
      "SELECT equipmentid FROM equipment WHERE status='available' ORDER BY equipmentid LIMIT 1",
    )
  ).rows[0].equipmentid;
  const invalid = await post("/admin/access/overrides", {
    userId: memberId,
    kind: "equipment",
    resourceId: equipment,
    durationMinutes: 31,
    reason: "Supervision",
  });
  assert.equal(invalid.status, 400);
  const result = await post("/admin/access/overrides", {
    userId: memberId,
    kind: "equipment",
    resourceId: equipment,
    durationMinutes: 5,
    reason: "Supervision",
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const id = result.body.data.id;
  assert.equal(
    (await post(`/admin/access/overrides/${id}/revoke`, { reason: "Finished" }))
      .status,
    200,
  );
  assert.equal(
    (await post(`/admin/access/overrides/${id}/revoke`, { reason: "Finished" }))
      .status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM app_staff_audit WHERE action='access.override_revoked' AND entity_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    (await get(`/admin/access/overrides?userId=${memberId}`)).body.data[0]
      .resourceName,
  );
});

test("card metadata records the last successful physical tap, excluding renewal traffic", async () => {
  const waivers = await get("/me/waivers", memberToken);
  for (const waiver of waivers.body.data) {
    const signed = await post(
      `/me/waivers/${waiver.id}/sign`,
      waiverAcceptance(waiver),
      memberToken,
    );
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
  }
  const room = (
    await pool.query(
      "INSERT INTO room(name,location,status) VALUES('NFC metadata room','Test','available') RETURNING roomid",
    )
  ).rows[0].roomid;
  await pool.query(
    `INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'NFC metadata test',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '10 minutes') AT TIME ZONE 'UTC','confirmed')`,
    [memberId, room],
  );
  const card = await assign("AA998877", memberId, {
    label: "Last-use regression",
  });
  assert.equal(card.status, 201);
  const physical = await tap("AA998877", { checkIn: true });
  assert.equal(physical.body.data.allowed, true, JSON.stringify(physical.body));
  const renewed = await tap("AA998877", { renewal: true });
  assert.equal(renewed.body.data.allowed, true);
  // Readers renew about once a second while a card stays on; only taps and refused
  // renewals reach the permanent audit log.
  const refused = await tap("CC445566", { renewal: true });
  assert.equal(refused.body.data.allowed, false);
  const decisions = [physical, renewed, refused].map((r) => r.body.data.decisionId);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT entity_id::int AS id FROM app_staff_audit WHERE entity_type='app_device_access_event' AND entity_id=ANY($1::int[]) ORDER BY entity_id",
        [decisions],
      )
    ).rows.map((r) => r.id),
    [decisions[0], decisions[2]],
  );
  // Live-lease counts look up every unexpired grant without a machine id.
  const planner = await pool.connect();
  try {
    await planner.query("BEGIN");
    await planner.query("SET LOCAL enable_seqscan=off");
    const plan = (
      await planner.query(
        "EXPLAIN SELECT target_kind,target_id FROM app_device_access_event WHERE allowed=true AND expires_at>NOW()",
      )
    ).rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(plan, /app_device_event_live_leases/);
  } finally {
    await planner.query("ROLLBACK");
    planner.release();
  }
  const event = (
    await pool.query(
      "SELECT created_at FROM app_device_access_event WHERE id=$1",
      [physical.body.data.decisionId],
    )
  ).rows[0];
  const list = await get(`/admin/access/cards?userId=${memberId}`),
    saved = list.body.data.find((c: any) => c.id === card.body.data.id);
  assert.equal(saved.lastUsedAt, event.created_at.toISOString());
  assert.equal(saved.lastReader, "front");
  const history = await get(
    `/admin/access/events?userId=${memberId}&result=allowed`,
  );
  assert.ok(
    history.body.data.items.some(
      (e: any) => e.id === physical.body.data.decisionId,
    ),
  );
  assert.ok(
    !history.body.data.items.some(
      (e: any) => e.id === renewed.body.data.decisionId,
    ),
  );
});

test("ended renewal runs collapse to their first and last rows without changing usage, presence or the audit log", async () => {
  const reader = "compaction-reader", machine = 990001;
  const base: Date = (await pool.query("SELECT date_trunc('second',NOW())-INTERVAL '3 hours' AS t")).rows[0].t;
  // Rows a reader would have written three hours ago: one tap, then a renewal every second.
  const events = (userId: number, from: number, to: number, kind: "tap" | "renewal" | "refusal" = "renewal") =>
    pool.query(
      `INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at,created_at,is_tap)
      SELECT $1::text,gen_random_uuid(),$2::int,'equipment',$3::int,$6::text<>'refusal',CASE WHEN $6::text='refusal' THEN 'NOT_TRAINED' ELSE 'ELIGIBLE' END,
        CASE WHEN $6::text<>'refusal' THEN start+INTERVAL '5 seconds' END,start,$6::text='tap'
      FROM (SELECT $7::timestamptz+s*INTERVAL '1 second' AS start FROM generate_series($4::int,$5::int) s) t`,
      [reader, userId, machine, from, to, kind, base],
    );
  await events(memberId, 0, 0, "tap");
  await events(memberId, 1, 30);
  await events(otherId, 10, 40); // another member on the same reader is a separate run
  await events(memberId, 66, 66, "refusal"); // the refused renewal that ended the session
  await events(memberId, 120, 129); // a later session after a gap
  await events(memberId, 200, 200); // a single renewal stays as it is
  // Leases still live, or ended within the last ten minutes, are left alone.
  await pool.query(
    `INSERT INTO app_device_access_event(reader_id,request_id,user_id,target_kind,target_id,allowed,reason,expires_at,created_at,is_tap)
    SELECT $1::text,gen_random_uuid(),$2::int,'equipment',$3::int,true,'ELIGIBLE',NOW()-s*INTERVAL '1 minute'+INTERVAL '5 seconds',NOW()-s*INTERVAL '1 minute',false
    FROM generate_series(0,4) s`,
    [reader, memberId, machine],
  );
  const usage = async () =>
    (
      await pool.query(
        `SELECT range_agg(tstzrange(created_at,expires_at,'[)'))::text AS spans,max(created_at) AS seen,
          (SELECT count(*)::int FROM app_staff_audit WHERE entity_type='app_device_access_event') AS audits
        FROM app_device_access_event WHERE reader_id=$1 AND allowed AND expires_at>created_at`,
        [reader],
      )
    ).rows[0];
  const start = await usage();
  assert.equal(await compactReaderRenewals(pool), 28 + 29 + 8);
  assert.deepEqual(await usage(), start, "authorized time, latest activity and the audit log are unchanged");
  // The session continues; the next pass folds the new renewals into the same run.
  await events(memberId, 31, 60);
  const continued = await usage();
  assert.equal(await compactReaderRenewals(pool), 30);
  assert.deepEqual(await usage(), continued);
  assert.equal(await compactReaderRenewals(pool), 0, "a repeated pass changes nothing");
  const kept = (
    await pool.query(
      `SELECT user_id AS "userId",is_tap AS tap,allowed,EXTRACT(EPOCH FROM created_at-$2::timestamptz)::int AS "from",
        EXTRACT(EPOCH FROM expires_at-$2::timestamptz)::int AS "until"
      FROM app_device_access_event WHERE reader_id=$1 AND created_at<NOW()-INTERVAL '1 hour' ORDER BY user_id,created_at`,
      [reader, base],
    )
  ).rows;
  assert.deepEqual(kept, [
    { userId: memberId, tap: true, allowed: true, from: 0, until: 5 },
    { userId: memberId, tap: false, allowed: true, from: 1, until: 64 },
    { userId: memberId, tap: false, allowed: true, from: 60, until: 65 },
    { userId: memberId, tap: false, allowed: false, from: 66, until: null },
    { userId: memberId, tap: false, allowed: true, from: 120, until: 133 },
    { userId: memberId, tap: false, allowed: true, from: 129, until: 134 },
    { userId: memberId, tap: false, allowed: true, from: 200, until: 205 },
    { userId: otherId, tap: false, allowed: true, from: 10, until: 44 },
    { userId: otherId, tap: false, allowed: true, from: 40, until: 45 },
  ]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM app_device_access_event WHERE reader_id=$1 AND created_at>NOW()-INTERVAL '1 hour'",
        [reader],
      )
    ).rows[0].n,
    5,
  );
  // Deleting a tap or a refusal is still audited.
  const refusal = (
    await pool.query(
      "DELETE FROM app_device_access_event WHERE reader_id=$1 AND NOT allowed RETURNING id",
      [reader],
    )
  ).rows[0].id;
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM app_staff_audit WHERE action='app_device_access_event.delete' AND entity_id=$1",
        [refusal],
      )
    ).rows[0].n,
    1,
  );
});
