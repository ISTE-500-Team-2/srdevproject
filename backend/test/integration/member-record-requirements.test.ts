import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { memberRequirements } from "../../src/memberRequirements.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";
import { AccessService } from "../../src/services/AccessService.js";

const database = "arbor_record_requirements_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
const timeZone = "America/New_York";
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

test("an unsigned equipment waiver doesn't block the record's check-in verdict", async () => {
  // A required equipment-only waiver, which gates machines but not the door.
  await pool.query(
    `INSERT INTO waiver(name,version,description,effectivedate,isactive,required,policy_scope)
     VALUES('Record test laser waiver','v1','Laser cutter risks.',NOW() AT TIME ZONE 'UTC',true,true,'equipment')`,
  );
  const id = await new UserModel(pool).create({
    firstName: "Facility",
    lastName: "Signer",
    email: "facility-signer@example.invalid",
    phone: "555-0101",
    password: "unused-test-credential",
    dob: "1990-01-01",
  });
  await pool.query(
    `INSERT INTO user_waiver(userid,waiverid,signdate,approval)
     SELECT $1,waiverid,NOW() AT TIME ZONE 'UTC',true FROM waiver WHERE isactive AND required AND policy_scope='facility'`,
    [id],
  );
  // Desk check-in's own waiver check passes...
  await new AccessService(pool, timeZone).assertWaivers(id);
  // ...so the record must agree.
  const { waivers } = await memberRequirements(pool, timeZone, id);
  assert.ok(waivers.required > 0);
  assert.equal(waivers.signed, waivers.required);
  assert.deepEqual(waivers.missing, []);
});
