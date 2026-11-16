import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { StaffModel } from "../../src/models/StaffModel.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_record_activity_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
let created = false,
  app: ReturnType<typeof createApp>,
  token: string,
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
  adminId = login.user.id;
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test("an active member's record shows their changes and visits, not sign-in bookkeeping", async () => {
  const id = await new UserModel(pool).create({
    firstName: "Busy",
    lastName: "Member",
    email: "busy-member@example.invalid",
    phone: "555-0102",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
  const row = (action: string, type: string, source: string, minutesAgo: number) =>
    pool.query(
      `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,source,created_at)
       VALUES($1,$2,$3,$4,$2,'Fixture',$5,NOW()-make_interval(mins=>$6))`,
      [adminId, id, action, type, source, minutesAgo],
    );
  // A few real things, then a week of sign-ins and queued email: far more than one page.
  await row("user.access_suspended", "user", "application", 600);
  await row("check_in.insert", "check_in", "database", 590);
  await row("user.access_active", "user", "application", 580);
  for (let i = 0; i < 80; i++) {
    const [action, type] = ([
      ["app_session.insert", "app_session"],
      ["app_refresh_token.insert", "app_refresh_token"],
      ["app_refresh_family.update", "app_refresh_family"],
      ["app_notification_outbox.insert", "app_notification_outbox"],
    ] as const)[i % 4]!;
    await row(action, type, "database", 500 - i);
  }
  const r = await request(app).get(`/api/admin/users/${id}`).set("Authorization", "Bearer " + token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items: { action: string; entityType: string }[] = r.body.data.audit.items;
  const noise = ["app_session", "app_refresh_token", "app_refresh_family", "app_notification_outbox"];
  assert.deepEqual(items.filter((a) => noise.includes(a.entityType)), []);
  for (const action of ["user.access_active", "check_in.insert", "user.access_suspended"])
    assert.ok(items.some((a) => a.action === action), action);
  // The change log reads the same trail and still gets every row.
  const everything = await new StaffModel(pool, "America/New_York").audits({ subjectId: id });
  assert.equal(everything.length, 51);
  assert.equal(everything.some((a) => a.action === "user.access_active"), false);
});
