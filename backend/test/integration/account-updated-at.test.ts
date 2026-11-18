import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { PeopleRepository } from "../../src/models/staff/people.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { migrate } from "../../src/scripts/migrate.js";

const database = "arbor_account_updated_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

const member = (name: string) =>
  new UserModel(pool).create({
    firstName: name,
    lastName: "Dates",
    email: `${name.toLowerCase()}-dates@example.invalid`,
    phone: "555-0109",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
const longAgo = "2020-01-01T00:00:00Z";
const age = async (id: number) =>
  (await pool.query<{ updated: Date }>(`SELECT updated_at AS updated FROM "user" WHERE userid=$1`, [id])).rows[0]!.updated;

test("the staff record carries the sign-up date and when the account record last changed", async () => {
  const id = await member("Joined");
  const people = new PeopleRepository(pool);
  const person = (await people.person(id))!;
  assert.ok(person.createdAt instanceof Date);
  assert.ok(person.updatedAt instanceof Date);
  assert.ok(Math.abs(person.updatedAt!.getTime() - Date.now()) < 60_000);

  // Profile, status, access, conduct and role changes all move it.
  const changes: [string, () => Promise<unknown>][] = [
    ["profile", async () => people.updatePerson(id, "Joined", "Renamed", "555-0110", (await people.person(id))!.revision)],
    ["status", async () => people.accountStatus(id, "inactive", "Moved away", (await people.person(id))!.revision)],
    ["access", async () => people.access(id, "suspended", "Unpaid", (await people.person(id))!.revision)],
    ["conduct", async () => people.conduct(id, true, (await people.person(id))!.revision)],
    ["role", () => people.setRole(id, "member", ["member", "instructor"])],
  ];
  for (const [what, change] of changes) {
    await pool.query(`UPDATE "user" SET updated_at=$2 WHERE userid=$1`, [id, longAgo]);
    assert.equal((await age(id)).toISOString(), "2020-01-01T00:00:00.000Z");
    await change();
    assert.ok((await age(id)).getTime() > Date.parse("2025-01-01"), what);
  }

  // Signing in, a password change and email confirmation are not account edits.
  await pool.query(`UPDATE "user" SET updated_at=$2 WHERE userid=$1`, [id, longAgo]);
  await pool.query(`UPDATE "user" SET password='rehashed',password_changed_at=NOW(),email_confirmed=true WHERE userid=$1`, [id]);
  assert.equal((await age(id)).toISOString(), "2020-01-01T00:00:00.000Z");
});

test("the migration fills existing accounts from their change log, else their sign-up date", async () => {
  // Accounts from before the change log existed: made without leaving a database change row.
  await pool.query(`ALTER TABLE "user" DISABLE TRIGGER app_capture_change`);
  const logged = await member("Logged"),
    quiet = await member("Quiet");
  await pool.query(`UPDATE "user" SET registration_date='2021-03-04 05:06:07' WHERE userid=ANY($1)`, [[logged, quiet]]);
  await pool.query(`ALTER TABLE "user" ENABLE TRIGGER app_capture_change`);
  // Rebuild the layout from before 061, then apply it again on these accounts.
  await pool.query(`DROP TRIGGER app_touch_user_updated_at ON "user"`);
  await pool.query(`ALTER TABLE "user" DROP COLUMN updated_at`);
  await pool.query(`DELETE FROM app_migration WHERE name='061_account_updated_at.sql'`);
  await pool.query(
    `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,created_at)
     VALUES (NULL,$1,'user.conduct_flagged','user',$1,'Test',$2),(NULL,$1,'payment.void','payment',1,'Test','2024-09-09T00:00:00Z')`,
    [logged, "2023-06-07T08:09:10Z"],
  );
  await migrate(pool);
  assert.equal((await age(logged)).toISOString(), "2023-06-07T08:09:10.000Z");
  assert.equal((await age(quiet)).toISOString(), "2021-03-04T05:06:07.000Z");
  // A new account after the migration is stamped when it is made.
  assert.ok((await age(await member("Fresh"))).getTime() > Date.parse("2025-01-01"));
});
