import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { requireActor } from "../../src/accountPolicy.js";
import { BillingPricing } from "../../src/billing/pricing.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_account_policy_" + randomBytes(6).toString("hex") + "_mvc_test";
const owner = new Pool(),
  pool = new Pool({ database });
let created = false;
const userWithRole = async (role: string) =>
  (
    await pool.query(
      "SELECT ur.userid FROM user_role ur JOIN role r USING(roleid) WHERE r.role=$1 ORDER BY ur.userid LIMIT 1",
      [role],
    )
  ).rows[0].userid as number;

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

test("actor policy enforces active account, staff payment permission and admin role", async () => {
  const member = await userWithRole("member"),
    admin = await userWithRole("admin");
  assert.equal((await requireActor(pool, member)).id, member);
  await assert.rejects(requireActor(pool, member, { staff: true }), { code: "STAFF_REQUIRED" });
  await assert.rejects(requireActor(pool, member, { admin: true }), { code: "ADMIN_REQUIRED" });
  assert.equal((await requireActor(pool, admin, { staff: true, admin: true })).id, admin);
  await assert.rejects(requireActor(pool, 2147483000), { code: "ACCESS_DENIED" });
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='staff'", [member]);
  try {
    assert.equal((await requireActor(pool, member, { staff: true })).id, member);
    await assert.rejects(requireActor(pool, member, { staff: true, admin: true }), { code: "ADMIN_REQUIRED" });
  } finally {
    await pool.query("DELETE FROM user_role WHERE userid=$1 AND roleid=(SELECT roleid FROM role WHERE role='staff')", [member]);
  }
});

test("billing services use the shared actor policy for suspended accounts", async () => {
  const member = await userWithRole("member");
  await pool.query(`UPDATE "user" SET accessstatus='suspended' WHERE userid=$1`, [member]);
  try {
    await assert.rejects(requireActor(pool, member), { code: "ACCESS_DENIED" });
    await assert.rejects(new BillingPricing(pool).offers(member), { code: "ACCESS_DENIED" });
  } finally {
    await pool.query(`UPDATE "user" SET accessstatus='active' WHERE userid=$1`, [member]);
  }
});
