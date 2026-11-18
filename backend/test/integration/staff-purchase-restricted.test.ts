// Staff-assisted purchase for a member whose access is restricted names the member's problem,
// not the staff user's own permissions.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_purchase_restricted_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const app = createApp(pool, {
  jwtKey: randomBytes(32),
  port: 8080,
  host: "127.0.0.1",
  secureCookies: false,
  demoLogin: true,
  allowedOrigins: ["http://localhost:8080"],
  timeZone: "America/New_York",
});
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let created = false,
  admin: Session,
  member: Session;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
  admin = (await request(app).post("/api/auth/demo").send({ role: "admin" })).body.data;
  member = (await request(app).post("/api/auth/demo").send({ role: "member" })).body.data;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test("selling to a suspended or inactive member explains the member's restriction", async () => {
  const path = `/api/admin/users/${member.user.id}/purchase`;
  const offers = () => request(app).get(path).set("Authorization", "Bearer " + admin.accessToken);
  assert.equal((await offers()).status, 200);

  await pool.query(`UPDATE "user" SET accessstatus='suspended' WHERE userid=$1`, [member.user.id]);
  let response = await offers();
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "MEMBER_RESTRICTED");
  assert.match(response.body.error.message, /^This member’s access is suspended\./);
  const purchase = await request(app)
    .post(path)
    .set("Authorization", "Bearer " + admin.accessToken)
    .set("X-CSRF-Token", admin.csrfToken)
    .send({ planId: 1 });
  assert.equal(purchase.body.error?.code, "MEMBER_RESTRICTED");

  await pool.query(`UPDATE "user" SET accessstatus='active',status='inactive' WHERE userid=$1`, [member.user.id]);
  response = await offers();
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /^This member’s account isn’t active\./);
  assert.doesNotMatch(response.body.error.message, /Your account/);

  await pool.query(`UPDATE "user" SET status='active' WHERE userid=$1`, [member.user.id]);
  assert.equal((await offers()).status, 200);
});
