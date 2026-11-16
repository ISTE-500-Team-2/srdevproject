import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { cookieName } from "../../src/middleware/auth.js";
import { runNotificationBatch, type PendingNotification } from "../../src/notifications/worker.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { confirmationToken } from "../helpers/confirmation.js";

const database = "arbor_sign_in_changes_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(), pool = new Pool({ database });
const config = { jwtKey: randomBytes(32), port: 8080, host: "127.0.0.1", secureCookies: false, demoLogin: true, allowedOrigins: ["http://localhost:8080"], timeZone: "America/New_York" };
const app = createApp(pool, config);
let created = false;
type Session = { accessToken: string; csrfToken: string; user: { id: number; email: string }; cookie: string };

const take = (r: request.Response): Session => ({
  ...r.body.data,
  cookie: (r.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith(cookieName + "="))!.split(";")[0]!,
});
const as = (who: Session) => ({
  get: (path: string) => request(app).get("/api" + path).set("Authorization", "Bearer " + who.accessToken),
  post: (path: string, body: object = {}) => request(app).post("/api" + path).set("Authorization", "Bearer " + who.accessToken)
    .set("Cookie", who.cookie).set("X-CSRF-Token", who.csrfToken).send(body),
  delete: (path: string) => request(app).delete("/api" + path).set("Authorization", "Bearer " + who.accessToken)
    .set("X-CSRF-Token", who.csrfToken).send({}),
});
const login = (email: string, password: string, remember = false) =>
  request(app).post("/api/auth/login").send({ email, password, remember });
async function register(name: string, password = "GoodPassword123!") {
  const email = `${name}@example.invalid`;
  // Sign-up allows 10 a quarter hour per address; a fresh app keeps that budget out of these tests.
  const signup = createApp(pool, config);
  assert.equal((await request(signup).post("/api/auth/register")
    .send({ firstName: name, lastName: "Tester", email, phone: "1112223333", dob: "1990-01-01", password })).status, 202);
  await request(signup).post("/api/auth/confirm").send({ token: await confirmationToken(pool, email) });
  return { email, password };
}
const outbox = async (userId: number, kind: string) => (await pool.query(
  `SELECT payload, status FROM app_notification_outbox WHERE userid=$1 AND kind=$2 ORDER BY id`, [userId, kind])).rows;
const linkToken = async (userId: number) =>
  new URL((await outbox(userId, "email_change_confirmation")).at(-1).payload.confirmationUrl).hash.slice(1);
const actions = async (userId: number) => (await pool.query(
  `SELECT action FROM app_staff_audit WHERE subject_id=$1 AND action LIKE 'profile.%' ORDER BY id`, [userId])).rows.map((r) => r.action);

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Explicit isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test("a member changes their password: every other sign-in ends and this one carries on", async () => {
  const account = await register("pat");
  const here = take(await login(account.email, account.password, true));
  const elsewhere = take(await login(account.email, account.password));
  // A reset link sent earlier would undo the change.
  assert.equal((await request(app).post("/api/auth/password-reset").send({ email: account.email })).status, 202);

  const wrong = await as(here).post("/me/password", { currentPassword: "NotMyPassword1!", newPassword: "BrandNewPassword9!" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, "CURRENT_PASSWORD_INVALID");
  assert.equal(wrong.body.error.field, "currentPassword");
  assert.equal((await as(here).post("/me/password", { currentPassword: account.password, newPassword: account.password })).body.error.code, "PASSWORD_UNCHANGED");
  assert.equal((await as(here).post("/me/password", { currentPassword: account.password, newPassword: "short" })).status, 400);

  const changed = await as(here).post("/me/password", { currentPassword: account.password, newPassword: "BrandNewPassword9!" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const fresh = take(changed);
  // The fresh sign-in keeps "Remember me" from the one it replaced.
  const refreshCookie = (changed.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith(cookieName + "="))!;
  assert.match(refreshCookie, /Max-Age=/);
  assert.equal((await as(fresh).get("/auth/session")).status, 200);
  for (const old of [here, elsewhere]) assert.equal((await as(old).get("/auth/session")).status, 401);
  assert.equal((await request(app).post("/api/auth/refresh").set("Cookie", elsewhere.cookie).set("X-CSRF-Token", elsewhere.csrfToken).send({})).status, 401);

  assert.equal((await login(account.email, account.password)).status, 401);
  assert.equal((await login(account.email, "BrandNewPassword9!")).status, 200);
  const reset = (await pool.query("SELECT count(*)::int AS n FROM app_password_reset WHERE userid=$1", [fresh.user.id])).rows[0].n;
  assert.equal(reset, 0);
  assert.deepEqual((await outbox(fresh.user.id, "password_changed")).map((r) => r.status), ["pending"]);
  assert.deepEqual(await actions(fresh.user.id), ["profile.password_changed"]);
  assert.ok((await as(fresh).get("/me/profile")).body.data.passwordChangedAt);
});

test("a new sign-in email applies only once its link is opened", async () => {
  const account = await register("robin");
  const other = await register("taken");
  const me = take(await login(account.email, account.password));
  const ask = (body: object) => as(me).post("/me/email-change", body);

  assert.equal((await ask({ email: account.email.toUpperCase(), currentPassword: account.password })).body.error.code, "EMAIL_UNCHANGED");
  const taken = await ask({ email: other.email, currentPassword: account.password });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.field, "email");
  assert.equal((await ask({ email: "robin.new@example.invalid", currentPassword: "WrongPassword1!" })).body.error.code, "CURRENT_PASSWORD_INVALID");

  const asked = await ask({ email: "Robin.New@Example.invalid", currentPassword: account.password });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.data.pendingEmail.email, "robin.new@example.invalid");
  assert.equal((await as(me).get("/me/profile")).body.data.pendingEmail.email, "robin.new@example.invalid");
  // Nothing changes yet: the old address still signs in.
  assert.equal((await login(account.email, account.password)).status, 200);
  // One link a minute.
  assert.equal((await as(me).post("/me/email-change/resend")).status, 429);

  const token = await linkToken(me.user.id);
  const confirmed = await request(app).post("/api/auth/email-change/confirm").send({ token });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.email, "robin.new@example.invalid");
  assert.equal((await login(account.email, account.password)).status, 401);
  assert.equal((await login("robin.new@example.invalid", account.password)).status, 200);
  // The link works once, and the session that asked carries on.
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token })).body.error.code, "EMAIL_CHANGE_INVALID");
  assert.equal((await as(me).get("/me/profile")).body.data.pendingEmail, null);
  assert.deepEqual(await actions(me.user.id), ["profile.email_change_requested", "profile.email_changed"]);
});

test("the link goes to the new address and the heads-up to the old one", async () => {
  const sendAll = async (userId: number) => {
    const sent: PendingNotification[] = [];
    // Only this member's mail; other tests' queued mail stays put.
    await pool.query(`UPDATE app_notification_outbox SET due_at=now()+interval '1 day' WHERE userid<>$1 AND status='pending'`, [userId]);
    await runNotificationBatch(pool, async (job) => {
      sent.push(job);
      return { messageId: `test-${job.id}` };
    }, { batchSize: 50 });
    return Object.fromEntries(sent.filter((j) => j.kind.startsWith("email_change")).map((j) => [j.kind, j.email]));
  };
  const sam = await register("sam");
  const me = take(await login(sam.email, sam.password));
  await as(me).post("/me/email-change", { email: "sam.new@example.invalid", currentPassword: sam.password });
  assert.deepEqual(await sendAll(me.user.id), { email_change_confirmation: "sam.new@example.invalid", email_change_requested: sam.email });

  // Confirmed before the mail went out: the heads-up still goes to the old address; the used link isn't sent.
  const kim = await register("kim");
  const her = take(await login(kim.email, kim.password));
  await as(her).post("/me/email-change", { email: "kim.new@example.invalid", currentPassword: kim.password });
  await request(app).post("/api/auth/email-change/confirm").send({ token: await linkToken(her.user.id) });
  assert.deepEqual(await sendAll(her.user.id), { email_change_requested: kim.email });
  assert.equal((await outbox(her.user.id, "email_change_confirmation"))[0].status, "obsolete");
});

test("a cancelled or expired change can't be confirmed, and a resend replaces the old link", async () => {
  const account = await register("lee");
  const me = take(await login(account.email, account.password));
  await as(me).post("/me/email-change", { email: "lee.new@example.invalid", currentPassword: account.password });
  const first = await linkToken(me.user.id);
  await pool.query(`UPDATE app_email_change SET created_at=now()-interval '2 minutes' WHERE userid=$1`, [me.user.id]);
  assert.equal((await as(me).post("/me/email-change/resend")).status, 202);
  const second = await linkToken(me.user.id);
  assert.notEqual(second, first);
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token: first })).status, 400);
  assert.deepEqual((await outbox(me.user.id, "email_change_confirmation")).map((r) => r.status), ["obsolete", "pending"]);

  await pool.query(`UPDATE app_email_change SET expires_at=now()-interval '1 second' WHERE userid=$1`, [me.user.id]);
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token: second })).status, 400);
  assert.equal((await as(me).get("/me/profile")).body.data.pendingEmail, null);

  await pool.query(`UPDATE app_email_change SET expires_at=now()+interval '1 day' WHERE userid=$1`, [me.user.id]);
  assert.equal((await as(me).delete("/me/email-change")).status, 200);
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token: second })).status, 400);
  assert.equal((await login(account.email, account.password)).status, 200);
  assert.equal((await as(me).post("/me/email-change/resend")).status, 404);
});

test("staff in a member's account can't change that member's email or password", async () => {
  const admin = take(await request(app).post("/api/auth/demo").send({ role: "admin" }));
  const account = await register("alex");
  const member = take(await login(account.email, account.password));
  assert.equal((await as(admin).post("/admin/account-mode", { userId: member.user.id })).status, 200);
  for (const [path, body] of [
    ["/me/password", { currentPassword: "x", newPassword: "BrandNewPassword9!" }],
    ["/me/email-change", { email: "alex.new@example.invalid", currentPassword: "x" }],
  ] as const) {
    const refused = await as(admin).post(path, body);
    assert.equal(refused.status, 403, path);
    assert.equal(refused.body.error.code, "NOT_IN_ACCOUNT_MODE");
  }
  assert.equal((await login(account.email, account.password)).status, 200);
});

// Someone who learned the password asks to move the account to their inbox; the member locks
// them out by changing or resetting the password. The waiting link must stop working.
test("changing or resetting the password cancels a waiting email change", async () => {
  const account = await register("casey");
  let me = take(await login(account.email, account.password));
  const intruder = () => as(me).post("/me/email-change", { email: "intruder@example.invalid", currentPassword: account.password });

  assert.equal((await intruder()).status, 202);
  const afterChange = await linkToken(me.user.id);
  const changed = await as(me).post("/me/password", { currentPassword: account.password, newPassword: "Locked-Out-Now1!" });
  assert.equal(changed.status, 200);
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token: afterChange })).status, 400);
  assert.deepEqual((await outbox(me.user.id, "email_change_confirmation")).map((r) => r.status), ["obsolete"]);
  me = take(changed);
  assert.equal((await as(me).get("/me/profile")).body.data.pendingEmail, null);

  account.password = "Locked-Out-Now1!";
  assert.equal((await intruder()).status, 202);
  const afterReset = await linkToken(me.user.id);
  assert.equal((await request(app).post("/api/auth/password-reset").send({ email: account.email })).status, 202);
  const reset = (await outbox(me.user.id, "password_reset")).at(-1).payload.resetUrl as string;
  const done = await request(app).post("/api/auth/password-reset/confirm").send({ token: new URL(reset).hash.slice(1), password: "Reset-And-Safe2!" });
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.equal((await request(app).post("/api/auth/email-change/confirm").send({ token: afterReset })).status, 400);
  assert.equal((await login(account.email, "Reset-And-Safe2!")).status, 200);
});

test("an unsubscribe from the link's inbox doesn't turn off the member's own notifications", async () => {
  const token = randomBytes(16).toString("hex");
  const hooked = createApp(pool, { ...config, brevoWebhookToken: token });
  const account = await register("drew");
  const me = take(await login(account.email, account.password));
  await as(me).post("/me/email-change", { email: "stranger@example.invalid", currentPassword: account.password });
  const enabled = async () => (await pool.query(
    "SELECT COALESCE((SELECT enabled FROM app_notification_preferences WHERE userid=$1),true) AS on", [me.user.id])).rows[0].on;

  // The provider already reported an unsubscribe for the link by the time the send is accepted…
  await pool.query(`INSERT INTO app_brevo_delivery_event(event_key,provider_message_id,event_type,occurred_at)
    VALUES('early-unsubscribe','link-message','unsubscribed',now())`);
  await pool.query(`UPDATE app_notification_outbox SET due_at=now()+interval '1 day' WHERE userid<>$1 AND status='pending'`, [me.user.id]);
  await runNotificationBatch(pool, async (job) => ({ messageId: job.kind === "email_change_confirmation" ? "link-message" : `other-${job.id}` }), { batchSize: 50 });
  assert.equal(await enabled(), true);
  // …or reports it afterwards.
  const unsubscribe = await request(hooked).post("/api/webhooks/brevo").set("Authorization", "Bearer " + token)
    .send({ event: "unsubscribed", "message-id": "<link-message>", ts_event: Math.floor(Date.now() / 1000) });
  assert.equal(unsubscribe.status, 204);
  assert.equal(await enabled(), true);
});

test("a confirmed change is recorded as the member's, signed in or not", async () => {
  const account = await register("eli");
  const me = take(await login(account.email, account.password));
  await as(me).post("/me/email-change", { email: "eli.new@example.invalid", currentPassword: account.password });
  await request(app).post("/api/auth/email-change/confirm").send({ token: await linkToken(me.user.id) });
  const rows = (await pool.query(`SELECT action, actor_id AS "actorId" FROM app_staff_audit
    WHERE subject_id=$1 AND action IN ('user.update','app_email_change.delete','profile.email_changed') ORDER BY id`, [me.user.id])).rows;
  assert.deepEqual(new Set(rows.map((r) => r.action)), new Set(["user.update", "app_email_change.delete", "profile.email_changed"]));
  for (const row of rows) assert.equal(row.actorId, me.user.id, row.action);
});

test("a typo can be fixed at once, resends don't repeat the heads-up, and expired changes are gone", async () => {
  const account = await register("fran");
  const me = take(await login(account.email, account.password));
  const ask = (email: string) => as(me).post("/me/email-change", { email, currentPassword: account.password });
  const notices = async () => (await outbox(me.user.id, "email_change_requested")).map((r) => r.payload.newEmail);

  assert.equal((await ask("fran@gmial.example")).status, 202);
  assert.equal((await ask("fran@gmail.example")).status, 202, "a different address replaces the first straight away");
  assert.equal((await ask("fran@gmail.example")).status, 429, "the same address again is a resend, once a minute");
  await pool.query(`UPDATE app_email_change SET created_at=now()-interval '2 minutes' WHERE userid=$1`, [me.user.id]);
  assert.equal((await as(me).post("/me/email-change/resend")).status, 202);
  assert.deepEqual(await notices(), ["fran@gmial.example", "fran@gmail.example"]);
  assert.equal((await as(me).get("/me/profile")).body.data.pendingEmail.email, "fran@gmail.example");

  await pool.query(`UPDATE app_email_change SET expires_at=now()-interval '1 second' WHERE userid=$1`, [me.user.id]);
  assert.equal((await as(me).post("/me/email-change/resend")).status, 404);
  assert.equal((await as(me).delete("/me/email-change")).status, 200);
  assert.deepEqual(await actions(me.user.id), ["profile.email_change_requested", "profile.email_change_requested"]);
});

test("a password change or reset logs the email change it cancelled", async () => {
  const account = await register("gus");
  let me = take(await login(account.email, account.password));
  await as(me).post("/me/email-change", { email: "gus.intruder@example.invalid", currentPassword: account.password });
  me = take(await as(me).post("/me/password", { currentPassword: account.password, newPassword: "Locked-Out-Now1!" }));
  await as(me).post("/me/email-change", { email: "gus.intruder2@example.invalid", currentPassword: "Locked-Out-Now1!" });
  await request(app).post("/api/auth/password-reset").send({ email: account.email });
  const reset = (await outbox(me.user.id, "password_reset")).at(-1).payload.resetUrl as string;
  assert.equal((await request(app).post("/api/auth/password-reset/confirm").send({ token: new URL(reset).hash.slice(1), password: "Reset-And-Safe2!" })).status, 204);
  const cancelled = (await pool.query(`SELECT reason, before_state AS before FROM app_staff_audit
    WHERE subject_id=$1 AND action='profile.email_change_cancelled' ORDER BY id`, [me.user.id])).rows;
  assert.deepEqual(cancelled, [
    { reason: "Cancelled because the password was changed", before: { pendingEmail: "gus.intruder@example.invalid" } },
    { reason: "Cancelled because the password was reset", before: { pendingEmail: "gus.intruder2@example.invalid" } },
  ]);
});
