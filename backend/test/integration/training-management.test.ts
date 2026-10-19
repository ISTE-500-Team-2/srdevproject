import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
const database =
  "arbor_training_" + randomBytes(6).toString("hex") + "_mvc_test";
const admin = new Pool(),
  pool = new Pool({ database });
let app: ReturnType<typeof createApp>, memberId: number, adminId: number;
let staff: ReturnType<typeof request.agent>,
  member: ReturnType<typeof request.agent>;
let csrf = "";
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  await initializeDemo(pool);
  app = createApp(pool, {
    jwtKey: randomBytes(32),
    port: 8080,
    host: "127.0.0.1",
    secureCookies: false,
    demoLogin: true,
    allowedOrigins: [],
    timeZone: "America/New_York",
  });
  staff = request.agent(app);
  member = request.agent(app);
  let r = await staff.post("/api/auth/demo").send({ role: "admin" });
  assert.equal(r.status, 200);
  adminId = r.body.data.user.id;
  csrf = r.body.data.csrfToken;
  staff.set("Authorization", "Bearer " + r.body.data.accessToken);
  r = await member.post("/api/auth/demo").send({ role: "member" });
  memberId = r.body.data.user.id;
  member.set("Authorization", "Bearer " + r.body.data.accessToken);
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
const patch = (p: string, b: unknown) =>
  staff
    .patch("/api" + p)
    .set("X-CSRF-Token", csrf)
    .send(b);
test("in-person training, expiry, renewal concurrency, revocation and durable audit", async () => {
  const course = {
    name: "Printer safety",
    description: "Observed equipment training",
    validityDays: 30,
    equipmentIds: [],
    reason: "Approved safety policy",
  };
  let r = await post("/training/catalog", course);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.data.id;
  const path = `/training/users/${memberId}/certifications/${id}`;
  const body = {
    trainedAt: new Date(Date.now() - 86400000).toISOString(),
    source: "equipment",
    verifiedInPerson: true,
    verificationReference: "Instructor observed demonstration",
    reason: "Training completed",
  };
  assert.equal(
    (await post(path, { ...body, verifiedInPerson: false })).status,
    400,
  );
  assert.equal(
    (await post(`/training/users/${adminId}/certifications/${id}`, body))
      .status,
    403,
  );
  assert.equal(
    (
      await post(path, {
        ...body,
        trainedAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).status,
    400,
  );
  r = await post(path, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.valid, true);
  assert.equal(r.body.data.approvedBy, adminId);
  assert.equal(r.body.data.revision, 1);
  const race = await Promise.all([
    post(path, { ...body, expectedRevision: 1 }),
    post(path, { ...body, expectedRevision: 1 }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (
      await post(path + "/revoke", {
        expectedRevision: 2,
        reason: "Retraining required after safety incident",
      })
    ).status,
    200,
  );
  r = await member.get("/api/me/certifications");
  assert.equal(r.body.data.find((x: any) => x.id === id).valid, false);
  assert.equal(
    (await post(path, { ...body, source: "external", expectedRevision: 3 }))
      .status,
    201,
  );
  await pool.query(
    "UPDATE user_certifications SET renewaldate=NOW()-interval '1 day' WHERE userid=$1 AND certid=$2",
    [memberId, id],
  );
  r = await member.get("/api/me/certifications");
  assert.equal(r.body.data.find((x: any) => x.id === id).valid, false);
  const log = await pool.query(
    "SELECT action,before_state,after_state FROM app_staff_audit WHERE entity_type='user_certification' ORDER BY id",
  );
  assert.deepEqual(
    log.rows.map((x) => x.action),
    [
      "training.approved",
      "training.renewed",
      "training.revoked",
      "training.renewed",
    ],
  );
  assert.equal(log.rows[1].before_state.revision, 1);
  assert.equal((await member.get("/api/training/catalog")).status, 403);
  assert.equal(
    (await patch("/training/catalog/" + id, { ...course, expectedRevision: 9 }))
      .status,
    409,
  );
});
test("instructor can approve but not configure; existing permission denies survive", async () => {
  await pool.query(
    "INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'",
    [memberId],
  );
  let r = await member.get("/api/auth/csrf");
  const c = r.body.data.csrfToken;
  r = await member.post("/api/training/catalog").set("X-CSRF-Token", c).send({
    name: "Unauthorized",
    validityDays: 30,
    equipmentIds: [],
    reason: "test",
  });
  assert.equal(r.status, 403);
  r = await member.get("/api/training/catalog");
  assert.equal(r.status, 200);
  const course = (await member.get("/api/training/catalog")).body.data[0];
  r = await member
    .post(`/api/training/users/${adminId}/certifications/${course.id}`)
    .set("X-CSRF-Token", c)
    .send({
      trainedAt: new Date(Date.now() - 60000).toISOString(),
      source: "external",
      verifiedInPerson: true,
      verificationReference: "Verified external training in person",
      reason: "Authorized instructor approval",
    });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.approvedBy, memberId);
  await pool.query(
    "UPDATE role_permission SET isallowed=false WHERE roleid=(SELECT roleid FROM role WHERE role='instructor') AND resourcename='certification' AND scopetype='global' AND permissionid=(SELECT permissionid FROM permission WHERE permissionname='read')",
  );
  assert.equal((await member.get("/api/training/catalog")).status, 403);
});
