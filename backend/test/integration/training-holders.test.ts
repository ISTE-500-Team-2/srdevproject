import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
const database =
  "arbor_holders_" + randomBytes(6).toString("hex") + "_mvc_test";
const admin = new Pool(),
  pool = new Pool({ database });
let memberId: number;
let staff: ReturnType<typeof request.agent>,
  member: ReturnType<typeof request.agent>;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await admin.query(`CREATE DATABASE "${database}"`);
  await initializeDemo(pool);
  const app = createApp(pool, {
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
const newCertification = async (name: string, endsInDays: number | null) =>
  (
    await pool.query(
      `INSERT INTO certifications(certid,name,validity_days,enddate)
       SELECT COALESCE(MAX(certid),0)+1,$1,365,(NOW()+make_interval(days=>$2::int)) AT TIME ZONE 'UTC' FROM certifications RETURNING certid`,
      [name, endsInDays],
    )
  ).rows[0].certid as number;

test("certification cards count current, expiring, expired and revoked holders, not just anyone current", async () => {
  const cert = await newCertification("Holder count safety", null);
  // Ends in 5 days, so everyone current on it runs out soon whatever their renewal date.
  const ending = await newCertification("Ending machine safety", 5);
  const users = (
    await pool.query(
      `INSERT INTO "user"(firstname,lastname,email,password,phone,status)
       SELECT 'Holder','Count '||g,'holder-'||g||'@example.invalid','x','0000000000',
         CASE WHEN g=6 THEN 'pending' ELSE 'active' END
       FROM generate_series(1,6) g ORDER BY g RETURNING userid`,
    )
  ).rows.map((row) => row.userid as number);
  await pool.query(
    `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
     SELECT 990000+v.i,($1::int[])[v.u],v.c,v.s,(NOW()+make_interval(days=>v.d)) AT TIME ZONE 'UTC'
     FROM (VALUES
       (1,1,$2::int,'active',200),   -- current
       (2,2,$2::int,'active',10),    -- current, expiring soon
       (3,3,$2::int,'active',-1),    -- expired yesterday
       (4,4,$2::int,'revoked',200),  -- revoked, renewal date still ahead
       (5,5,$2::int,'active',NULL),  -- current, never expires
       (6,6,$2::int,'active',200),   -- not an active account: not counted
       (7,1,$3::int,'active',200)    -- certification itself ends in 5 days
     ) v(i,u,c,s,d)`,
    [users, cert, ending],
  );
  const r = await staff.get("/api/training/catalog/holders");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = new Map(r.body.data.map((row: { id: number }) => [row.id, row]));
  assert.deepEqual(byId.get(cert), { id: cert, current: 3, expiringSoon: 1, expired: 1, revoked: 1 });
  assert.deepEqual(byId.get(ending), { id: ending, current: 1, expiringSoon: 1, expired: 0, revoked: 0 });
  // Counts are for the staff who manage the catalog.
  assert.equal((await member.get("/api/training/catalog/holders")).status, 403);
  await pool.query(
    "INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='staff'",
    [memberId],
  );
  assert.equal((await member.get("/api/training/catalog/holders")).status, 200);
  await pool.query(
    "DELETE FROM user_role WHERE userid=$1 AND roleid=(SELECT roleid FROM role WHERE role='staff')",
    [memberId],
  );
});

test("a member's certifications say when one was revoked", async () => {
  const cert = await newCertification("Revoked member safety", null);
  await pool.query(
    `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate,approved_at)
     VALUES(991000,$1,$2,'revoked',(NOW()+INTERVAL '200 days') AT TIME ZONE 'UTC',NOW()-INTERVAL '30 days')`,
    [memberId, cert],
  );
  const r = await member.get("/api/me/certifications");
  assert.equal(r.status, 200);
  const record = r.body.data.find((row: { id: number }) => row.id === cert);
  assert.equal(record.status, "revoked");
  assert.equal(record.valid, false);
  // The revocation trigger stamps it; the page uses it as the cut-off for new training.
  assert.ok(record.revokedAt && Date.parse(record.revokedAt) > Date.parse(record.approvedAt));
});
