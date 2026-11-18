import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { ComplianceReports } from "../../src/models/staff/compliance.js";
import { UserModel } from "../../src/models/UserModel.js";
import { initializeDemo } from "../../src/scripts/init-demo.js";

const database = "arbor_compliance_scope_" + randomBytes(6).toString("hex") + "_mvc_test";
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

test("an equipment waiver is only owed by members who use equipment that requires it", async () => {
  const equipmentWaiver = (
    await pool.query<{ waiverid: number; name: string }>(
      `SELECT waiverid,name FROM waiver WHERE policy_scope='equipment' AND isactive AND required
       AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')`,
    )
  ).rows[0]!;
  assert.ok(equipmentWaiver, "the demo publishes the specialized equipment waiver");
  const member = async (name: string) => {
    const id = await new UserModel(pool).create({
      firstName: name,
      lastName: "Scope",
      email: `${name.toLowerCase()}-scope@example.invalid`,
      phone: "555-0106",
      password: "unused-test-credential",
      dob: "1990-01-01",
    });
    // Every member here has signed the facility policies, and only those.
    await pool.query(
      `INSERT INTO user_waiver(userid,waiverid,signdate,approval)
       SELECT $1,waiverid,NOW() AT TIME ZONE 'UTC',true FROM waiver
       WHERE isactive AND required AND policy_scope='facility'`,
      [id],
    );
    return id;
  };
  const visitor = await member("Visitor");
  const trained = await member("Trained");
  const booked = await member("Booked");
  const signed = await member("Signed");

  await pool.query(
    `INSERT INTO certifications(certid,name,description,effectivedate)
     VALUES(98100,'Scope laser training','Waiver scope fixture',(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC')`,
  );
  await pool.query(
    `INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location,certid)
     VALUES('Scope laser','available',10,true,'Makerspace',98100)`,
  );
  for (const [usercertid, userId] of [[98101, trained], [98102, signed]])
    await pool.query(
      `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
       VALUES($1,$2,98100,'active',(NOW()+INTERVAL '1 year') AT TIME ZONE 'UTC')`,
      [usercertid, userId],
    );
  // Booked on waiver-required equipment without holding any training for it.
  const lathe = (
    await pool.query<{ id: number }>(
      `INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
       VALUES('Scope lathe','available',10,true,'Makerspace') RETURNING equipmentid AS id`,
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
     VALUES($1,$2,'Makerspace',(NOW()+INTERVAL '1 day') AT TIME ZONE 'UTC',(NOW()+INTERVAL '1 day 1 hour') AT TIME ZONE 'UTC','confirmed')`,
    [booked, lathe],
  );
  await pool.query(
    `INSERT INTO user_waiver(userid,waiverid,signdate,approval) VALUES($1,$2,NOW() AT TIME ZONE 'UTC',true)`,
    [signed, equipmentWaiver.waiverid],
  );

  const reports = new ComplianceReports(pool);
  const report = await reports.compliance(
    { waiverId: null, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0 },
    true,
  );
  const row = (id: number) => report.users.find((u) => u.id === id)!;
  const owes = (id: number) => row(id).missingWaivers.some((w) => w.startsWith(equipmentWaiver.name));

  // Signed every facility policy and never touches restricted equipment: nothing is missing,
  // so this member is not counted among those whose tags won't open.
  assert.equal(row(visitor).waiverCompliant, true);
  assert.equal(owes(visitor), false);
  assert.equal(row(visitor).issues.some((i) => i.kind === "waiver"), false);
  // Trained on, or booked on, equipment that needs the waiver: it is owed.
  for (const id of [trained, booked]) {
    assert.equal(row(id).waiverCompliant, false);
    assert.equal(owes(id), true);
  }
  assert.equal(row(signed).waiverCompliant, true);

  // The waiver's own count covers its users, not every member, and filtering to it agrees.
  const card = report.waiverBreakdown.find((w) => w.id === equipmentWaiver.waiverid)!;
  assert.ok(card.total >= 3 && card.total < report.summary.userCount);
  const filtered = await reports.compliance(
    { waiverId: equipmentWaiver.waiverid, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0 },
    true,
  );
  assert.deepEqual(filtered.waiverBreakdown, [card]);
  const inFilter = (id: number) => filtered.users.find((u) => u.id === id)!;
  assert.equal(inFilter(visitor).waiverCompliant, true);
  assert.equal(inFilter(trained).waiverCompliant, false);
  assert.equal(inFilter(signed).waiverCompliant, true);

  // A cancelled booking no longer makes the waiver owed.
  await pool.query(`UPDATE reservation SET status='cancelled' WHERE userid=$1`, [booked]);
  const after = await reports.compliance(
    { waiverId: null, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0 },
    true,
  );
  assert.equal(after.users.find((u) => u.id === booked)!.waiverCompliant, true);
});

test("an equipment waiver nobody owes yet keeps its card with no one counted", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // No equipment needs a waiver any more, so no member owes the equipment waiver.
    await client.query("UPDATE equipment SET waiverrequired=false");
    const equipmentWaiver = (
      await client.query<{ waiverid: number }>(
        `SELECT waiverid FROM waiver WHERE policy_scope='equipment' AND isactive AND required
         AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')`,
      )
    ).rows[0]!;
    const report = await new ComplianceReports(client).compliance(
      { waiverId: null, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0 },
      true,
    );
    assert.ok(report.summary.userCount > 0);
    const card = report.waiverBreakdown.find((w) => w.id === equipmentWaiver.waiverid);
    assert.deepEqual(card && { total: card.total, compliant: card.compliant, expiring: card.expiring },
      { total: 0, compliant: 0, expiring: 0 });
    assert.ok(report.users.every((u) => !u.missingWaivers.some((w) => w.startsWith(card!.name))));
    // Facility policies are still owed by every member in view.
    assert.ok(report.waiverBreakdown.some((w) => w.id !== equipmentWaiver.waiverid && w.total === report.summary.userCount));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("training is owed only for certifications a member holds or has held", async () => {
  const member = async (name: string) =>
    new UserModel(pool).create({
      firstName: name,
      lastName: "Training",
      email: `${name.toLowerCase()}-training@example.invalid`,
      phone: "555-0107",
      password: "unused-test-credential",
      dob: "1990-01-01",
    });
  const untrained = await member("Untrained");
  const current = await member("Current");
  const lapsed = await member("Lapsed");
  await pool.query(
    `INSERT INTO certifications(certid,name,description,effectivedate)
     VALUES(98200,'Scope router training','Training scope fixture',(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC')`,
  );
  await pool.query(
    `INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate) VALUES
     (98201,$1,98200,'active',(NOW()+INTERVAL '1 year') AT TIME ZONE 'UTC'),
     (98202,$2,98200,'active',(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC')`,
    [current, lapsed],
  );
  const reports = new ComplianceReports(pool);
  const all = await reports.compliance(
    { waiverId: null, certificationId: null, expiresWithinDays: null, userStatus: "active", offset: 0 },
    true,
  );
  const row = (id: number) => all.users.find((u) => u.id === id)!;

  // Never trained on anything: no training to renew, so nothing is missing or flagged.
  assert.equal(row(untrained).certificationCompliant, true);
  assert.deepEqual(row(untrained).missingCertifications, []);
  assert.equal(row(untrained).issues.some((i) => i.kind === "certification"), false);
  // Holding only this certification, current, isn't marked lapsed for every other one.
  assert.equal(row(current).certificationCompliant, true);
  assert.deepEqual(row(current).missingCertifications, []);
  // Lapsed training is still flagged, as expired.
  assert.equal(row(lapsed).certificationCompliant, false);
  assert.deepEqual(row(lapsed).missingCertifications, ["Scope router training"]);
  assert.equal(row(lapsed).issues.find((i) => i.kind === "certification")?.state, "expired");

  // The certification's card counts the members who hold it, not everyone.
  const card = all.certificationBreakdown.find((c) => c.id === 98200)!;
  assert.deepEqual({ total: card.total, compliant: card.compliant }, { total: 2, compliant: 1 });

  // Filtering to the certification asks who has it, so there everyone counts and the rest are missing.
  const filtered = await reports.compliance(
    { waiverId: null, certificationId: 98200, expiresWithinDays: null, userStatus: "active", offset: 0 },
    true,
  );
  assert.equal(filtered.certificationBreakdown[0]!.total, filtered.summary.userCount);
  const inFilter = (id: number) => filtered.users.find((u) => u.id === id)!;
  assert.equal(inFilter(untrained).certificationCompliant, false);
  assert.deepEqual(inFilter(untrained).missingCertifications, ["Scope router training"]);
  assert.equal(inFilter(current).certificationCompliant, true);
});
