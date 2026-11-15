import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { ComplianceReports, type ComplianceFilters } from "../../src/models/staff/compliance.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_compliance_attention_" + randomBytes(6).toString("hex") + "_mvc_test";
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

test("the Needs attention count is the same on every view, while the window's own count still narrows", async () => {
  const member = (name: string) =>
    new UserModel(pool).create({
      firstName: name,
      lastName: "Compliance",
      email: `${name.toLowerCase()}-compliance@example.invalid`,
      phone: "555-0105",
      password: "unused-test-credential",
      dob: "1990-01-01",
    });
  // Never signed anything: needs attention, but nothing of theirs is expiring.
  await member("Unsigned");
  // Signed everything, with a signature running out in ten days: inside the 30-day window.
  const expiring = await member("Expiring");
  await pool.query(
    `INSERT INTO user_waiver(userid,waiverid,signdate,approval,expires_at)
     SELECT $1,waiverid,NOW() AT TIME ZONE 'UTC',true,NOW()+INTERVAL '10 days' FROM waiver WHERE isactive AND required`,
    [expiring],
  );
  const reports = new ComplianceReports(pool);
  const view = (change: Partial<ComplianceFilters>) =>
    reports.compliance({
      waiverId: null,
      certificationId: null,
      expiresWithinDays: null,
      userStatus: "active",
      offset: 0,
      ...change,
    });
  const attention = await view({ attention: true }),
    expiringSoon = await view({ expiresWithinDays: 30 }),
    everyone = await view({});
  assert.ok(expiringSoon.summary.attentionUsers >= 1);
  assert.ok(expiringSoon.summary.attentionUsers < attention.summary.attentionUsers);
  for (const report of [attention, expiringSoon, everyone])
    assert.equal(report.summary.allAttentionUsers, attention.summary.attentionUsers);
});
