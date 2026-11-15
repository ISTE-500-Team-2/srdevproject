import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { EligibilityModel } from '../../src/models/EligibilityModel.js';
import { EntitlementRepository } from '../../src/models/staff/entitlements.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

// Coverage edges: back-to-back memberships, a day pass up to local midnight, and plan
// lengths counted on the facility's wall clock.
const database = `arbor_changeover_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const user = 900101, tz = 'America/New_York';
let created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
});
after(async () => {
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

/** Each test sees one fresh member without entitlements; everything rolls back. */
async function fixture(run: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`INSERT INTO "user"(userid,firstname,lastname,email,password,phone,status)
      VALUES($1,'Changeover','Fixture','changeover@example.invalid','not-a-login','0000000000','active')`, [user]);
    await run(db);
  } finally { await db.query('ROLLBACK'); db.release(); }
}
const membership = (db: PoolClient, from: string, to: string, status = 'active') => db.query(
  `INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
  VALUES($1,1,$2::timestamptz AT TIME ZONE 'UTC',$3::timestamptz AT TIME ZONE 'UTC',$4)`, [user, from, to, status]);
const covers = async (db: PoolClient, from: string, to = from) =>
  new EligibilityModel(db, tz).entitlement(user, new Date(from), new Date(to));

test('back-to-back memberships together cover a booking across the changeover', () => fixture(async db => {
  // January ends and February starts at midnight local (05:00Z); the booking is 11 PM to 1 AM.
  await membership(db, '2027-01-01T05:00:00Z', '2027-02-01T05:00:00Z');
  await membership(db, '2027-02-01T05:00:00Z', '2027-03-01T05:00:00Z');
  assert.equal((await covers(db, '2027-02-01T04:00:00Z', '2027-02-01T06:00:00Z')).membership, true);
  assert.equal((await covers(db, '2027-02-01T05:00:00Z')).membership, true, 'the changeover instant itself');
  assert.equal((await covers(db, '2027-01-31T15:00:00Z', '2027-02-28T15:00:00Z')).membership, true);
  assert.equal((await covers(db, '2027-02-28T23:00:00Z', '2027-03-01T05:00:01Z')).membership, false, 'past the last end');
  assert.equal((await covers(db, '2027-03-01T05:00:00Z')).membership, false, 'an end is exclusive');
}));

test('a gap or an inactive membership still breaks coverage', () => fixture(async db => {
  await membership(db, '2027-01-01T05:00:00Z', '2027-02-01T05:00:00Z');
  await membership(db, '2027-02-01T05:30:00Z', '2027-03-01T05:00:00Z');
  await membership(db, '2027-02-01T05:00:00Z', '2027-02-01T05:30:00Z', 'suspended');
  assert.equal((await covers(db, '2027-02-01T04:00:00Z', '2027-02-01T06:00:00Z')).membership, false);
  assert.equal((await covers(db, '2027-02-01T05:10:00Z')).membership, false);
  assert.equal((await covers(db, '2027-02-01T05:30:00Z', '2027-02-01T06:00:00Z')).membership, true);
}));

test('a day pass covers a slot ending exactly at local midnight, but not past it', () => fixture(async db => {
  await db.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,'2027-02-10','active')", [user]);
  // 11 PM to midnight EST on Feb 10 is 04:00Z to 05:00Z on Feb 11.
  const late = await covers(db, '2027-02-11T04:00:00Z', '2027-02-11T05:00:00Z');
  assert.deepEqual(late, { membership: false, dayPass: true });
  assert.equal((await covers(db, '2027-02-11T04:00:00Z', '2027-02-11T05:00:01Z')).dayPass, false, 'runs into the next day');
  assert.equal((await covers(db, '2027-02-11T05:00:00Z', '2027-02-11T06:00:00Z')).dayPass, false, 'starts on the next day');
  assert.equal((await covers(db, '2027-02-11T05:00:00Z')).dayPass, false, 'the instant of midnight is the next day');
  assert.equal((await covers(db, '2027-02-11T04:59:59Z')).dayPass, true);
  // In daylight time local midnight is 04:00Z.
  await db.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,'2027-11-06','active')", [user]);
  assert.equal((await covers(db, '2027-11-07T03:00:00Z', '2027-11-07T04:00:00Z')).dayPass, true);
}));

test('a monthly plan ends on the same local date and time it started', () => fixture(async db => {
  const repository = new EntitlementRepository(db, tz);
  // Jan 28, 2027 7:30 PM in New York is already Jan 29 in UTC; the plan runs to Feb 28 7:30 PM local.
  const evening = await repository.membershipWindow(user, '2027-01-29T00:30:00.000Z', 1);
  assert.equal(evening.endsAt.toISOString(), '2027-03-01T00:30:00.000Z');
  // DST starts on Mar 14, 2027: 10 AM EST on Feb 15 ends at 10 AM EDT on Mar 15.
  const acrossDst = await repository.membershipWindow(user, '2027-02-15T15:00:00.000Z', 1);
  assert.equal(acrossDst.endsAt.toISOString(), '2027-03-15T14:00:00.000Z');
  // The overlap check uses the same local end (the UTC sum would have stopped on Feb 28 00:30Z).
  await membership(db, '2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z');
  assert.equal((await repository.membershipWindow(user, '2027-01-29T00:30:00.000Z', 1)).overlap, true);
}));
