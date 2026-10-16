import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
const database =
    "arbor_access_reports_" + randomBytes(6).toString("hex") + "_mvc_test",
  admin = new Pool(),
  pool = new Pool({ database });
const secret = randomBytes(32).toString("hex"),
  hashKey = randomBytes(32).toString("hex"),
  uid = "04:A1:B2:C3:D4:E5:F6";
let app: ReturnType<typeof createApp>,
  staff: ReturnType<typeof request.agent>,
  member: ReturnType<typeof request.agent>,
  csrf: string,
  memberCsrf: string,
  memberId: number,
  adminId: number,
  equipmentId: number,
  roomId: number,
  certId: number,
  cardId: number,
  classId: number;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  await initializeDemo(pool);
  equipmentId = (
    await pool.query(
      "SELECT equipmentid FROM equipment ORDER BY equipmentid LIMIT 1",
    )
  ).rows[0].equipmentid;
  roomId = (await pool.query("SELECT roomid FROM room ORDER BY roomid LIMIT 1"))
    .rows[0].roomid;
  app = createApp(pool, {
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
        { id: "printer", secret, kind: "equipment", resourceId: equipmentId },
        { id: "entrance", secret, kind: "building" },
      ],
    },
  });
  staff = request.agent(app);
  member = request.agent(app);
  let r = await staff.post("/api/auth/demo").send({ role: "admin" });
  assert.equal(r.status, 200);
  csrf = r.body.data.csrfToken;
  adminId = r.body.data.user.id;
  staff.set("Authorization", "Bearer " + r.body.data.accessToken);
  r = await member.post("/api/auth/demo").send({ role: "member" });
  memberId = r.body.data.user.id;
  memberCsrf = r.body.data.csrfToken;
  member.set("Authorization", "Bearer " + r.body.data.accessToken);
  r = await post("/training/catalog", {
    name: "Machine training",
    validityDays: 365,
    equipmentIds: [equipmentId],
    reason: "Approved test policy",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  certId = r.body.data.id;
  r = await post("/admin/access/cards", {
    userId: memberId,
    uid,
    label: "Training test card",
    reason: "Verified member identity",
  });
  assert.equal(r.status, 201);
  cardId = r.body.data.id;
});
after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});
const post = (p: string, b: unknown) =>
  staff
    .post("/api" + p)
    .set("X-CSRF-Token", csrf)
    .send(b);
const memberPost = (p: string, b: unknown) =>
  member
    .post("/api" + p)
    .set("X-CSRF-Token", memberCsrf)
    .send(b);
function scan(
  opts: {
    reader?: string;
    uid?: string;
    eventId?: string;
    stamp?: string;
    secret?: string;
    checkIn?: boolean;
  } = {},
) {
  const body = JSON.stringify({
      uid: opts.uid ?? uid,
      eventId: opts.eventId ?? randomUUID(),
      checkIn: opts.checkIn ?? false,
    }),
    stamp = opts.stamp ?? String(Date.now()),
    signature = createHmac("sha256", opts.secret ?? secret)
      .update(stamp + "\n" + body)
      .digest("hex");
  return request(app)
    .post("/api/devices/decision")
    .set("Content-Type", "application/json")
    .set("X-Reader-ID", opts.reader ?? "printer")
    .set("X-Reader-Timestamp", stamp)
    .set("X-Reader-Signature", signature)
    .send(body);
}
test("authenticated NFC checks current eligibility, never caches safety decisions, and rejects replay", async () => {
  assert.equal((await scan({ secret: "wrong" })).status, 401);
  assert.equal((await scan({ stamp: String(Date.now() - 20000) })).status, 401);
  let r = await scan({ uid: "01020304" });
  assert.equal(r.body.data.reason, "CARD_NOT_ASSIGNED");
  assert.equal(r.body.data.member, null);
  r = await scan();
  assert.equal(r.body.data.reason, "WAIVER_REQUIRED");
  const waivers = (await member.get("/api/me/waivers")).body.data;
  for (const w of waivers)
    assert.equal(
      (await memberPost(`/me/waivers/${w.id}/sign`, { accepted: true })).status,
      200,
    );
  r = await scan();
  assert.equal(r.body.data.reason, "CERTIFICATION_REQUIRED");
  r = await post(`/training/users/${memberId}/certifications/${certId}`, {
    trainedAt: new Date(Date.now() - 60000).toISOString(),
    source: "equipment",
    verifiedInPerson: true,
    verificationReference: "In-person instructor demo",
    reason: "Completed",
  });
  assert.equal(r.status, 201);
  r = await scan();
  assert.equal(r.body.data.reason, "RESERVATION_REQUIRED");
  await pool.query(
    `INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status) VALUES($1,$2,'Test machine',(NOW()-interval '1 hour') AT TIME ZONE 'UTC',(NOW()+interval '1 hour') AT TIME ZONE 'UTC','confirmed')`,
    [memberId, equipmentId],
  );
  const eventId = randomUUID(),
    start = performance.now();
  r = await scan({ eventId, checkIn: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.allowed, true);
  assert.equal(r.body.data.member.id, memberId);
  assert.ok(r.body.data.member.email);
  assert.ok(r.body.data.leaseSeconds <= 5 && r.body.data.leaseSeconds > 0);
  assert.ok(performance.now() - start < 2000);
  assert.equal((await scan({ eventId })).status, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM check_in WHERE statusdesc='Authenticated NFC eligibility decision'",
      )
    ).rows[0].n,
    1,
  );
  await pool.query(
    "UPDATE user_certifications SET status='revoked' WHERE userid=$1 AND certid=$2",
    [memberId, certId],
  );
  assert.equal((await scan()).body.data.reason, "CERTIFICATION_REQUIRED");
  await pool.query(
    "UPDATE user_certifications SET status='active',renewaldate=(NOW()+interval '2 seconds') AT TIME ZONE 'UTC' WHERE userid=$1 AND certid=$2",
    [memberId, certId],
  );
  r = await scan();
  assert.ok(r.body.data.leaseSeconds > 0 && r.body.data.leaseSeconds <= 2);
  await pool.query(
    "UPDATE user_certifications SET renewaldate=(NOW()+interval '30 days') AT TIME ZONE 'UTC' WHERE userid=$1 AND certid=$2",
    [memberId, certId],
  );
  await pool.query(
    "UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1",
    [memberId],
  );
  assert.equal(
    (await scan({ reader: "entrance" })).body.data.reason,
    "ACCOUNT_BLOCKED",
  );
  await pool.query(
    "UPDATE \"user\" SET accessstatus='active' WHERE userid=$1",
    [memberId],
  );
  await pool.query(
    "UPDATE user_membership SET status='suspended' WHERE userid=$1",
    [memberId],
  );
  assert.equal((await scan()).body.data.reason, "ENTITLEMENT_REQUIRED");
  await pool.query(
    "UPDATE user_membership SET status='active' WHERE userid=$1",
    [memberId],
  );
});
test("short staff override bypasses only bookings; card revocation immediately blocks", async () => {
  await pool.query(
    "UPDATE reservation SET status='cancelled' WHERE equipmentid=$1",
    [equipmentId],
  );
  let r = await post("/admin/access/overrides", {
    userId: memberId,
    kind: "equipment",
    resourceId: equipmentId,
    endsAt: new Date(Date.now() + 3600000).toISOString(),
    reason: "Supervised access",
  });
  assert.equal(r.status, 400);
  r = await post("/admin/access/overrides", {
    userId: memberId,
    kind: "equipment",
    resourceId: equipmentId,
    endsAt: new Date(Date.now() + 600000).toISOString(),
    reason: "Supervised access",
  });
  assert.equal(r.status, 201);
  const override = r.body.data.id;
  assert.equal((await scan()).body.data.allowed, true);
  await pool.query(
    "UPDATE user_certifications SET status='revoked' WHERE userid=$1",
    [memberId],
  );
  assert.equal((await scan()).body.data.reason, "CERTIFICATION_REQUIRED");
  await pool.query(
    "UPDATE user_certifications SET status='active' WHERE userid=$1",
    [memberId],
  );
  assert.equal(
    (
      await post(`/admin/access/overrides/${override}/revoke`, {
        reason: "Supervision ended",
      })
    ).status,
    200,
  );
  assert.equal((await scan()).body.data.reason, "RESERVATION_REQUIRED");
  assert.equal((await scan({ reader: "entrance" })).body.data.allowed, true);
  assert.equal(
    (
      await post(`/admin/access/cards/${cardId}/revoke`, {
        expectedRevision: 1,
        reason: "Lost card",
      })
    ).status,
    200,
  );
  assert.equal(
    (await scan({ reader: "entrance" })).body.data.reason,
    "CARD_NOT_ASSIGNED",
  );
  const saved = (
    await pool.query("SELECT uid_hash FROM app_access_card WHERE id=$1", [
      cardId,
    ])
  ).rows[0];
  assert.equal(saved.uid_hash.length, 64);
  assert.ok(
    !JSON.stringify(
      (await staff.get("/api/admin/access/cards?userId=" + memberId)).body,
    ).includes(saved.uid_hash),
  );
});
test("class capacity is transactional, room conflicts preserved, and instructors have real rosters", async () => {
  await pool.query(
    "INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'",
    [adminId],
  );
  const body = {
    title: "Machine orientation",
    certificationId: certId,
    instructorId: adminId,
    roomId,
    capacity: 1,
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    endsAt: new Date(Date.now() + 90000000).toISOString(),
    reason: "Scheduled instructor-led training",
  };
  let r = await post("/classes", body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  classId = r.body.data.id;
  assert.equal(
    (await post("/classes", { ...body, title: "Conflict" })).status,
    409,
  );
  assert.equal(
    (await member.get(`/api/classes/${classId}/roster`)).status,
    403,
  );
  const race = await Promise.all([
    memberPost(`/classes/${classId}/enroll`, {}),
    post(`/classes/${classId}/enroll`, {}),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const slot = (
    await pool.query(
      "SELECT reservation_id FROM app_training_class WHERE id=$1",
      [classId],
    )
  ).rows[0].reservation_id;
  assert.equal(
    (await post(`/admin/reservations/${slot}/cancel`, {})).status,
    403,
    "Instructor booking restriction remains intact",
  );
  assert.equal(
    (await memberPost(`/reservations/${slot}/cancel`, {})).status,
    404,
  );
  const roster = (await staff.get(`/api/classes/${classId}/roster`)).body.data;
  assert.equal(roster.length, 1);
  const enrolled = roster[0].userId;
  assert.equal(
    (
      await post(`/classes/${classId}/attendance`, {
        userId: enrolled,
        status: "attended",
        reason: "Observed",
      })
    ).status,
    409,
  );
  await pool.query(
    `UPDATE reservation SET starttime=(NOW()-interval '1 hour') AT TIME ZONE 'UTC',endtime=(NOW()+interval '1 hour') AT TIME ZONE 'UTC' WHERE reservationid=(SELECT reservation_id FROM app_training_class WHERE id=$1)`,
    [classId],
  );
  assert.equal(
    (
      await post(`/classes/${classId}/attendance`, {
        userId: enrolled,
        status: "attended",
        reason: "Actual attendance observed",
      })
    ).status,
    200,
  );
  const count = (await pool.query("SELECT COUNT(*) FROM user_certifications"))
    .rows[0].count;
  assert.equal(Number(count), 1, "Attendance must not silently grant training");
});
test("real reports reconcile refunds, clip usage, export structured CSV/PDF and preserve immutable audit", async () => {
  await pool.query(
    `INSERT INTO payment(userid,price,paymentstatus,paymentdate,method) VALUES($1,100,'paid',NOW() AT TIME ZONE 'UTC','cash'),($1,20,'refunded',NOW() AT TIME ZONE 'UTC','card'),($1,999,'pending',NOW() AT TIME ZONE 'UTC','card')`,
    [memberId],
  );
  await pool.query(
    `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_status,payment_method,request_key,refund_cents) SELECT id,$1,CURRENT_DATE,CURRENT_DATE+30,50000,'full_before_start','cancelled','refunded','manual',$2,50000 FROM app_studio ORDER BY id LIMIT 1`,
    [memberId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_status,payment_method,request_key,refund_cents) SELECT id,$1,CURRENT_DATE,CURRENT_DATE+30,30000,'full_before_start','cancelled','refund_pending','manual',$2,30000 FROM app_studio ORDER BY id OFFSET 1 LIMIT 1`,
    [memberId, randomUUID()],
  );
  const day = (
      await pool.query(
        "SELECT to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day",
      )
    ).rows[0].day,
    q = `from=${day}&to=${day}&period=daily`;
  let r = await staff.get("/api/admin/reports?" + q);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(
    d.revenue.reduce((a: number, x: any) => a + Number(x.gross), 0),
    920,
  );
  assert.equal(
    d.revenue.reduce((a: number, x: any) => a + Number(x.refunds), 0),
    520,
  );
  assert.equal(
    d.revenue.reduce((a: number, x: any) => a + Number(x.net), 0),
    400,
  );
  assert.equal(d.classes.find((x: any) => x.id === classId).enrolled, 1);
  assert.equal(d.classes.find((x: any) => x.id === classId).attended, 1);
  assert.ok(d.active.activeUsers >= 1);
  assert.ok(
    Number(d.usage[0].authorizedHours) <= (5 / 3600) * 5,
    "Overlapping leases must be unioned",
  );
  assert.equal((await member.get("/api/admin/reports?" + q)).status, 403);
  assert.equal(
    (await staff.get("/api/admin/reports?from=2026-99-10&to=2026-99-11"))
      .status,
    400,
  );
  r = await staff.get("/api/admin/reports/export?" + q + "&format=csv");
  assert.equal(r.status, 200);
  assert.ok(r.body.data.content.includes('"gross"'));
  assert.ok(r.body.data.content.includes("Studio rental"));
  r = await staff.get("/api/admin/reports/export?" + q + "&format=pdf");
  assert.equal(r.status, 200);
  assert.equal(
    Buffer.from(r.body.data.content, "base64").subarray(0, 8).toString(),
    "%PDF-1.4",
  );
  await assert.rejects(
    pool.query(
      "UPDATE app_staff_audit SET reason='changed' WHERE id=(SELECT MIN(id) FROM app_staff_audit)",
    ),
    (e: any) => e.code === "55000",
  );
  await assert.rejects(
    pool.query("DELETE FROM app_staff_audit"),
    (e: any) => e.code === "55000",
  );
  await assert.rejects(
    pool.query("TRUNCATE app_staff_audit"),
    (e: any) => e.code === "55000",
  );
  r = await staff.get(
    "/api/admin/audit?actorId=" + adminId + "&action=training.approved",
  );
  assert.equal(r.status, 200);
  assert.ok(r.body.data.items.length > 0);
  assert.ok(
    r.body.data.items.every(
      (x: any) => x.actorId === adminId && x.action === "training.approved",
    ),
  );
  assert.equal(
    (
      await post(`/classes/${classId}/cancel`, {
        expectedRevision: 1,
        reason: "Schedule changed",
      })
    ).status,
    200,
  );
});

test('software authorization matrix has no false grants across 128 eligibility combinations',async()=>{
 const timings:number[]=[];let matches=0;
 for(let mask=0;mask<128;mask++){
  const flags=Array.from({length:7},(_,bit)=>(mask&(1<<bit))!==0);
  await pool.query('UPDATE app_access_card SET active=$2 WHERE id=$1',[cardId,flags[0]]);
  await pool.query('UPDATE "user" SET accessstatus=$2 WHERE userid=$1',[memberId,flags[1]?'active':'suspended']);
  await pool.query('UPDATE user_membership SET status=$2 WHERE userid=$1',[memberId,flags[2]?'active':'suspended']);
  await pool.query('UPDATE user_waiver SET approval=$2 WHERE userid=$1',[memberId,flags[3]]);
  await pool.query('UPDATE user_certifications SET status=$2 WHERE userid=$1',[memberId,flags[4]?'active':'revoked']);
  await pool.query('UPDATE reservation SET status=$2 WHERE userid=$1 AND equipmentid=$3',[memberId,flags[5]?'confirmed':'cancelled',equipmentId]);
  await pool.query('UPDATE equipment SET status=$2 WHERE equipmentid=$1',[equipmentId,flags[6]?'available':'maintenance']);
  const start=performance.now(),r=await scan();timings.push(performance.now()-start);
  assert.equal(r.status,200,JSON.stringify(r.body));const expected=flags.every(Boolean);assert.equal(r.body.data.allowed,expected,`Eligibility matrix mask ${mask}`);if(r.body.data.allowed===expected)matches++;
  if(!expected)assert.equal(r.body.data.member,null,'Deny must not expose member identity');
 }
 timings.sort((a,b)=>a-b);assert.equal(matches,128);assert.ok(timings.at(-1)!<2000,'Local API response must complete within two seconds');
 console.log('Isolated software benchmark',JSON.stringify({cases:128,matches,falseGrants:0,p50Ms:timings[64],p95Ms:timings[Math.ceil(timings.length*.95)-1],maxMs:timings.at(-1),physicalHardware:false}));
});
