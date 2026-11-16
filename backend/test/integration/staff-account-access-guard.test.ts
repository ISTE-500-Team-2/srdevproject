import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { SessionModel } from "../../src/models/SessionModel.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

// Non-admin staff may not manage NFC cards or supervised use on staff or admin accounts,
// the same rule the member record's other staff actions apply.
const database = "arbor_staff_guard_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const secret = randomBytes(32).toString("hex");
let created = false,
  app: ReturnType<typeof createApp>;
interface Session {
  token: string;
  csrf: string;
  id: number;
}
let admin: Session, staff: Session, memberId: number, colleagueId: number;

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
    devices: { cardHashKey: randomBytes(32).toString("hex"), readers: [{ id: "front", secret, kind: "building" }] },
  };
  app = createApp(pool, config);
  const demo = async (role: string) => (await request(app).post("/api/auth/demo").send({ role })).body.data;
  const a = await demo("admin"),
    m = await demo("member");
  admin = { token: a.accessToken, csrf: a.csrfToken, id: a.user.id };
  memberId = m.user.id;
  const person = async (name: string, role: string) => {
    const id = await new UserModel(pool).create({
      firstName: name,
      lastName: "Guard",
      email: `${name.toLowerCase()}-guard@example.invalid`,
      phone: "555-0103",
      password: "unused-test-credential",
      dob: "1990-01-01",
    });
    await pool.query(
      "INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role=$2",
      [id, role],
    );
    return id;
  };
  const staffId = await person("Desk", "staff");
  colleagueId = await person("Colleague", "staff");
  const session = await new SessionModel(pool, config.jwtKey).create(staffId, false);
  staff = { token: session.token, csrf: session.csrfToken, id: staffId };
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

const post = (as: Session, path: string, body: object) =>
  request(app).post("/api" + path).set("Authorization", "Bearer " + as.token).set("X-CSRF-Token", as.csrf).send(body);
const assign = (as: Session, userId: number, uid: string) =>
  post(as, "/admin/access/cards", { uid, userId, label: "Guard card", reason: "Verified identity" });
const cardAction = (as: Session, card: { id: number; revision: number }, action: "revoke" | "reactivate") =>
  post(as, `/admin/access/cards/${card.id}/${action}`, { expectedRevision: card.revision, reason: "Guard test" });
// Each supervised session gets a room of its own, so bookings never overlap.
async function supervise(as: Session, userId: number) {
  const room = (
    await pool.query("INSERT INTO room(name,location,status) VALUES('Guard room '||gen_random_uuid(),'Test','available') RETURNING roomid")
  ).rows[0].roomid;
  return post(as, "/admin/access/overrides", { userId, kind: "room", resourceId: room, durationMinutes: 10, reason: "Supervised" });
}
const endSupervision = (as: Session, id: number) =>
  post(as, `/admin/access/overrides/${id}/revoke`, { reason: "Guard test" });
function refused(r: request.Response) {
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "ADMIN_REQUIRED");
}

test("staff can't assign, revoke or reactivate cards on staff or admin accounts", async () => {
  refused(await assign(staff, colleagueId, "AA000001"));
  refused(await assign(staff, admin.id, "AA000002"));
  // Members stay theirs to manage.
  const memberCard = await assign(staff, memberId, "AA000003");
  assert.equal(memberCard.status, 201, JSON.stringify(memberCard.body));
  const revokedMemberCard = await cardAction(staff, memberCard.body.data, "revoke");
  assert.equal(revokedMemberCard.status, 200, JSON.stringify(revokedMemberCard.body));
  // Administrators manage staff cards; staff can't touch the result.
  const colleagueCard = await assign(admin, colleagueId, "AA000004");
  assert.equal(colleagueCard.status, 201, JSON.stringify(colleagueCard.body));
  refused(await cardAction(staff, colleagueCard.body.data, "revoke"));
  const revoked = await cardAction(admin, colleagueCard.body.data, "revoke");
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  refused(await cardAction(staff, revoked.body.data, "reactivate"));
  const active = await pool.query("SELECT active FROM app_access_card WHERE id=$1", [colleagueCard.body.data.id]);
  assert.equal(active.rows[0].active, false);
});

test("staff can't start or end supervised use for staff or admin accounts", async () => {
  refused(await supervise(staff, colleagueId));
  refused(await supervise(staff, admin.id));
  const forMember = await supervise(staff, memberId);
  assert.equal(forMember.status, 201, JSON.stringify(forMember.body));
  const forColleague = await supervise(admin, colleagueId);
  assert.equal(forColleague.status, 201, JSON.stringify(forColleague.body));
  refused(await endSupervision(staff, forColleague.body.data.id));
  const open = await pool.query("SELECT revoked_at FROM app_access_override WHERE id=$1", [forColleague.body.data.id]);
  assert.equal(open.rows[0].revoked_at, null);
  assert.equal((await endSupervision(staff, forMember.body.data.id)).status, 200);
  assert.equal((await endSupervision(admin, forColleague.body.data.id)).status, 200);
});
