import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_last_admin_role_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
let created = false,
  app: ReturnType<typeof createApp>,
  token: string,
  csrf: string,
  adminId: number;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
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
  };
  app = createApp(pool, config);
  const login = (await request(app).post("/api/auth/demo").send({ role: "admin" })).body.data;
  token = login.accessToken;
  csrf = login.csrfToken;
  adminId = login.user.id;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test("the only active administrator can take the admin role from a suspended administrator", async () => {
  const id = await new UserModel(pool).create({
    firstName: "Former",
    lastName: "Admin",
    email: "former-admin@example.invalid",
    phone: "555-0104",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
  await pool.query(
    "INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role='admin'",
    [id],
  );
  await pool.query(`UPDATE "user" SET status='suspended' WHERE userid=$1`, [id]);
  // Leave the signed-in administrator as the only active one.
  await pool.query(
    `UPDATE "user" SET status='suspended' WHERE userid<>$1 AND status='active'
     AND userid IN (SELECT userid FROM user_role JOIN role USING(roleid) WHERE role='admin')`,
    [adminId],
  );
  const person = await request(app).get(`/api/admin/users/${id}`).set("Authorization", "Bearer " + token);
  assert.equal(person.status, 200, JSON.stringify(person.body));
  const r = await request(app)
    .post(`/api/admin/users/${id}/role`)
    .set("Authorization", "Bearer " + token)
    .set("X-CSRF-Token", csrf)
    .send({ role: "member", roles: ["member"], revision: person.body.data.user.revision, reason: "Left the team" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.roles, ["member"]);
});
