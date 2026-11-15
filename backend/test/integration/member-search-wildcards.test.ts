import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { PeopleRepository } from "../../src/models/staff/people.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_member_search_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL)
    throw Error("Isolated PostgreSQL required");
  await owner.query(`CREATE DATABASE "${database}"`);
  created = true;
  await initializeDemo(pool);
});
after(async () => {
  await pool.end();
  if (created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test("member search matches %, _ and \\ literally", async () => {
  for (const [firstName, email] of [
    ["Jo", "j_smith@example.invalid"],
    ["Jas", "jasmith@example.invalid"],
  ]) {
    const id = await new UserModel(pool).create({
      firstName: firstName!,
      lastName: "Smith",
      email: email!,
      phone: "555-0106",
      password: "unused-test-credential",
      dob: "1990-01-01",
    });
    await pool.query(`UPDATE "user" SET email_confirmed=true WHERE userid=$1`, [id]);
  }
  const people = new PeopleRepository(pool);
  const emails = async (search: string) => (await people.users(search, 0)).map((p) => p.email);
  assert.ok((await emails("")).length > 1);
  assert.deepEqual(await emails("_"), ["j_smith@example.invalid"]);
  assert.deepEqual(await emails("j_smith"), ["j_smith@example.invalid"]);
  assert.deepEqual(await emails("%"), []);
  assert.deepEqual(await emails("\\"), []);
});
