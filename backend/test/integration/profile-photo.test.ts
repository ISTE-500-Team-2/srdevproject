import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { ProfilePhotoModel } from "../../src/models/ProfilePhotoModel.js";
import { profilePhotoField } from "../../src/profilePhoto.js";
import { dataUrl, jpeg, webpLossy } from "../helpers/photos.js";

const database = "arbor_profile_photo_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(), pool = new Pool({ database });
const config = { jwtKey: randomBytes(32), port: 8080, host: "127.0.0.1", secureCookies: false, demoLogin: true, allowedOrigins: ["http://localhost:8080"], timeZone: "America/New_York" };
const app = createApp(pool, config);
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let created = false, admin: Session, member: Session;

const as = (who: Session) => ({
  get: (path: string) => request(app).get("/api" + path).set("Authorization", "Bearer " + who.accessToken),
  put: (path: string, body: object = {}) => request(app).put("/api" + path).set("Authorization", "Bearer " + who.accessToken).set("X-CSRF-Token", who.csrfToken).send(body),
  post: (path: string, body: object = {}) => request(app).post("/api" + path).set("Authorization", "Bearer " + who.accessToken).set("X-CSRF-Token", who.csrfToken).send(body),
  delete: (path: string) => request(app).delete("/api" + path).set("Authorization", "Bearer " + who.accessToken).set("X-CSRF-Token", who.csrfToken).send({}),
});
const audits = async (userId: number) => (await pool.query(
  `SELECT action, reason, actor_id AS "actorId" FROM app_staff_audit WHERE subject_id=$1 AND action LIKE 'profile.photo%' ORDER BY id`, [userId])).rows;
const sessionVersion = async (who: Session) => (await as(who).get("/auth/session")).body.data.user.photoVersion;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Explicit isolated PostgreSQL required");
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

test("a member adds, replaces and removes their profile photo", async () => {
  assert.equal((await as(member).get("/me/photo")).body.data, null);
  assert.equal(await sessionVersion(member), null);

  const first = dataUrl("image/jpeg", jpeg(256, 256));
  const saved = await as(member).put("/me/photo", { image: first });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const version = saved.body.data.version;
  assert.deepEqual((await as(member).get("/me/photo")).body.data, { version, image: first });
  // Every signed-in view of the account carries the version, so pages know to fetch the photo.
  assert.equal(await sessionVersion(member), version);

  // Saving the same photo again changes nothing and logs nothing.
  assert.equal((await as(member).put("/me/photo", { image: first })).body.data.version, version);
  const second = dataUrl("image/webp", webpLossy(256, 256));
  const replaced = await as(member).put("/me/photo", { image: second });
  assert.notEqual(replaced.body.data.version, version);
  assert.deepEqual((await as(member).get("/me/photo")).body.data, { version: replaced.body.data.version, image: second });

  const removed = await as(member).delete("/me/photo");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { version: null });
  assert.equal((await as(member).get("/me/photo")).body.data, null);
  assert.equal(await sessionVersion(member), null);
  // Removing a photo that is already gone is not another change.
  assert.equal((await as(member).delete("/me/photo")).status, 200);

  // The change log says what happened; it never stores the image itself.
  assert.deepEqual(await audits(member.user.id), [
    { action: "profile.photo_updated", reason: "Member added a profile photo", actorId: member.user.id },
    { action: "profile.photo_updated", reason: "Member changed their profile photo", actorId: member.user.id },
    { action: "profile.photo_deleted", reason: "Member removed their profile photo", actorId: member.user.id },
  ]);
  const stored = await pool.query(`SELECT count(*)::int AS n FROM app_staff_audit
    WHERE subject_id=$1 AND (before_state::text LIKE '%base64%' OR after_state::text LIKE '%base64%')`, [member.user.id]);
  assert.equal(stored.rows[0].n, 0);
});

test("only valid photos with a session's CSRF token are saved", async () => {
  const invalid = await as(member).put("/me/photo", { image: dataUrl("image/svg+xml", Buffer.from("<svg/>")) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_PHOTO");
  assert.equal(invalid.body.error.field, "image");

  const forged = await request(app).put("/api/me/photo").set("Authorization", "Bearer " + member.accessToken)
    .send({ image: dataUrl("image/jpeg", jpeg(256, 256)) });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.code, "CSRF_INVALID");

  const anonymous = await request(app).get("/api/me/photo");
  assert.equal(anonymous.status, 401);
  // Oversized bodies stop at the JSON parser.
  const huge = await as(member).put("/me/photo", { image: `data:image/jpeg;base64,${"A".repeat(120_000)}` });
  assert.equal(huge.status, 413);
  assert.equal((await as(member).get("/me/photo")).body.data, null);
});

/**
 * Hold an uncommitted photo change in its own transaction, start `request`, wait until it is blocked
 * on the account lock, then commit and return the request's response.
 */
async function racing(userId: number, change: (model: ProfilePhotoModel) => Promise<void>, start: () => Promise<request.Response>) {
  const held = await pool.connect();
  try {
    await held.query("BEGIN");
    const model = new ProfilePhotoModel(held);
    await model.lockVersion(userId);
    await change(model);
    const response = start();
    for (let tries = 0; ; tries++) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [database]);
      if (rows[0].n > 0) break;
      if (tries > 400) throw new Error("The request never waited for the photo lock.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await held.query("COMMIT");
    return await response;
  } catch (error) {
    await held.query("ROLLBACK");
    throw error;
  } finally {
    held.release();
  }
}

// A request that waited for another change must act on what that change committed.
test("a remove that waits for a concurrent upload removes the uploaded photo", async () => {
  await as(member).delete("/me/photo");
  const uploaded = profilePhotoField(dataUrl("image/jpeg", jpeg(96, 96)));
  const removed = await racing(member.user.id, (model) => model.save(member.user.id, uploaded), () => as(member).delete("/me/photo").then((r) => r));
  assert.equal(removed.status, 200);
  assert.equal((await as(member).get("/me/photo")).body.data, null);
});

test("re-saving a photo that a concurrent change just replaced saves it again", async () => {
  const original = dataUrl("image/jpeg", jpeg(80, 80));
  const version = (await as(member).put("/me/photo", { image: original })).body.data.version;
  const replacement = profilePhotoField(dataUrl("image/jpeg", jpeg(81, 81)));
  const resaved = await racing(member.user.id, (model) => model.save(member.user.id, replacement), () => as(member).put("/me/photo", { image: original }).then((r) => r));
  assert.equal(resaved.status, 200);
  assert.deepEqual((await as(member).get("/me/photo")).body.data, { version, image: original });
  await as(member).delete("/me/photo");
});

test("staff in a member's account see that member's photo but cannot change it", async () => {
  const image = dataUrl("image/jpeg", jpeg(128, 128));
  const version = (await as(member).put("/me/photo", { image })).body.data.version;
  assert.equal((await as(admin).post("/admin/account-mode", { userId: member.user.id })).status, 200);
  try {
    assert.equal(await sessionVersion(admin), version);
    assert.deepEqual((await as(admin).get("/me/photo")).body.data, { version, image });
    const replace = await as(admin).put("/me/photo", { image: dataUrl("image/jpeg", jpeg(64, 64)) })
      .set("X-Account-Subject", String(member.user.id));
    assert.equal(replace.status, 403);
    assert.equal(replace.body.error.code, "NOT_IN_ACCOUNT_MODE");
    assert.equal((await as(admin).delete("/me/photo").set("X-Account-Subject", String(member.user.id))).status, 403);
    assert.equal((await as(member).get("/me/photo")).body.data.version, version);
  } finally {
    await as(admin).post("/admin/account-mode/end");
  }
  // Back in their own session, the admin's photo is their own (none yet).
  assert.equal((await as(admin).get("/me/photo")).body.data, null);
});

test("staff see members' photos in batches; members can't", async () => {
  const image = dataUrl("image/jpeg", jpeg(64, 64));
  const version = (await as(member).put("/me/photo", { image })).body.data.version;
  try {
    const batch = await as(admin).get(`/admin/photos?ids=${member.user.id},${admin.user.id},${member.user.id}`);
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.deepEqual(batch.body.data, { [member.user.id]: { version, image } });
    assert.match(batch.headers["cache-control"] ?? "", /no-store/);
    // Directory and record reads say which photo is current, so lists only ask for people with one.
    const directory = await as(admin).get(`/admin/users?search=${encodeURIComponent("Demo")}`);
    assert.equal(directory.body.data.items.find((p: { id: number }) => p.id === member.user.id)?.photoVersion, version);
    assert.equal((await as(admin).get(`/admin/users/${member.user.id}`)).body.data.user.photoVersion, version);

    assert.equal((await as(member).get(`/admin/photos?ids=${member.user.id}`)).status, 403);
    for (const ids of ["", "abc", "0", Array.from({ length: 51 }, (_, i) => i + 1).join(",")])
      assert.equal((await as(admin).get(`/admin/photos?ids=${ids}`)).status, 400, ids);
  } finally {
    await as(member).delete("/me/photo");
  }
});

test("staff remove a member's photo with a reason; a photo changed meanwhile is not removed", async () => {
  const version = (await as(member).put("/me/photo", { image: dataUrl("image/jpeg", jpeg(70, 70)) })).body.data.version;
  const remove = (body: object) => request(app).delete(`/api/admin/users/${member.user.id}/photo`)
    .set("Authorization", "Bearer " + admin.accessToken).set("X-CSRF-Token", admin.csrfToken).send(body);

  assert.equal((await remove({ version })).status, 400, "a reason is required");
  const stale = await remove({ version: "an-older-photo", reason: "Not a photo of the member" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "STALE_RECORD");
  assert.equal((await as(member).get("/me/photo")).body.data.version, version);

  const memberTries = await request(app).delete(`/api/admin/users/${member.user.id}/photo`)
    .set("Authorization", "Bearer " + member.accessToken).set("X-CSRF-Token", member.csrfToken).send({ version, reason: "Mine" });
  assert.equal(memberTries.status, 403);

  const removed = await remove({ version, reason: "Not a photo of the member" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await as(member).get("/me/photo")).body.data, null);
  const logged = await pool.query(`SELECT actor_id AS "actorId", reason, before_state AS before FROM app_staff_audit
    WHERE action='user.photo_removed' AND subject_id=$1`, [member.user.id]);
  assert.deepEqual(logged.rows, [{ actorId: admin.user.id, reason: "Not a photo of the member", before: { photoVersion: version } }]);
  // The member hears that it happened, never the staff member's reason.
  const mail = await pool.query(`SELECT payload FROM app_notification_outbox WHERE userid=$1 AND kind='photo_removed'`, [member.user.id]);
  assert.deepEqual(mail.rows, [{ payload: {} }]);
  // Removing again is not another change.
  assert.equal((await remove({ version, reason: "Not a photo of the member" })).status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_staff_audit WHERE action='user.photo_removed'`)).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_notification_outbox WHERE kind='photo_removed'`)).rows[0].n, 1);
});
