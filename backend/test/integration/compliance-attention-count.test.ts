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

test("members are only measured against training they hold, so never training isn't a lapse", async () => {
  const reports = new ComplianceReports(pool);
  const view = (change: Partial<ComplianceFilters> = {}) =>
    reports.compliance({ waiverId: null, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0, ...change }, true);
  const baseline = await view();
  const certs = (
    await pool.query<{ certid: number }>(
      `INSERT INTO certifications(certid,name) SELECT COALESCE(MAX(certid),0)+n,'Lapse fixture '||n FROM certifications,generate_series(1,2) n
       GROUP BY n RETURNING certid`,
    )
  ).rows.map((r) => r.certid);
  const person = (name: string) =>
    new UserModel(pool).create({
      firstName: name, lastName: "Training", email: `${name.toLowerCase()}-training@example.invalid`,
      phone: "555-0106", password: "unused-test-credential", dob: "1990-01-01",
    });
  const hold = (userid: number, certid: number, status: string, renewal: string) =>
    pool.query(
      `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
       SELECT COALESCE(MAX(usercertid),0)+1,$1,$2,$3,(NOW()+$4::interval) AT TIME ZONE 'UTC' FROM user_certifications`,
      [userid, certid, status, renewal],
    );
  const current = await person("Current"), lapsed = await person("Lapsed"), revoked = await person("Revoked"), untrained = await person("Untrained");
  // Current on the first machine and never trained on the second: still fully current.
  await hold(current, certs[0]!, "active", "1 year");
  await hold(lapsed, certs[0]!, "active", "-1 day");
  await hold(revoked, certs[1]!, "revoked", "1 year");
  const report = await view();
  const row = (id: number) => report.users.find((u) => u.id === id)!;
  assert.equal(row(current).certificationCompliant, true);
  assert.deepEqual(row(current).missingCertifications, []);
  assert.equal(row(untrained).certificationCompliant, true);
  assert.deepEqual(row(untrained).issues.filter((i) => i.kind === "certification"), []);
  assert.equal(row(lapsed).certificationCompliant, false);
  assert.ok(row(lapsed).issues.some((i) => i.kind === "certification" && i.state === "expired"));
  assert.equal(row(revoked).certificationCompliant, false);
  // The Today page's "need training renewed" count rises only by the two real lapses.
  const needRenewal = (r: typeof report) => r.summary.userCount - r.summary.certificationCompliantUsers;
  assert.equal(needRenewal(report) - needRenewal(baseline), 2);
  // Each certification's card counts the people who hold it, not every member.
  const card = (id: number) => report.certificationBreakdown.find((c) => c.id === id)!;
  assert.deepEqual([card(certs[0]!).total, card(certs[0]!).compliant], [2, 1]);
  assert.deepEqual([card(certs[1]!).total, card(certs[1]!).compliant], [1, 0]);
  // Filtering to one certification still leaves people who never took it out of the lapses.
  const filtered = await view({ certificationId: certs[1]! });
  assert.equal(filtered.users.find((u) => u.id === current)!.certificationCompliant, true);
  assert.equal(filtered.users.find((u) => u.id === revoked)!.certificationCompliant, false);
});
