import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { waiverAcceptance } from '../helpers/waiver.js';
import { DisposableApp, type TestClient } from '../helpers/appHarness.js';
import { migrate } from '../../src/scripts/migrate.js';

const harness = new DisposableApp('arbor_roles_pricing_');
const { pool } = harness;
before(() => harness.setup());
beforeEach(() => harness.restart());
after(() => harness.teardown());
const client = () => harness.client({ firstName: 'Purchase', lastName: 'Roles' });
const DAY = 86_400_000;

async function plan(admin: TestClient, kind: 'membership' | 'day_pass', price = '50.00') {
  const r = await admin.post('/admin/plans', {
    name: 'Plan ' + randomUUID().slice(0, 8), kind, price, months: kind === 'membership' ? 1 : null,
    benefits: 'Shop access', active: true, reason: 'Integration test plan',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data as { id: number; price: string };
}
const issue = (admin: TestClient, userId: number, body: Record<string, unknown>) =>
  admin.post(`/admin/users/${userId}/entitlements`, {
    requestId: randomUUID(), paymentStatus: 'paid', method: 'cash', reference: '', reason: 'Desk sale', ...body,
  });
const record = async (admin: TestClient, userId: number) => {
  const r = await admin.get(`/admin/users/${userId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.user as { roles: string[]; automaticRoles: string[]; primaryRole: string; revision: number };
};
async function signPolicies(user: TestClient) {
  for (const w of (await user.get('/me/waivers')).body.data)
    assert.equal((await user.post(`/me/waivers/${w.id}/sign`, waiverAcceptance(w))).status, 200);
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const dayOffset = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + days * DAY));

test('FR-006/FR-008: subscriber and day-pass labels follow what the member holds, and staff cannot set them', async () => {
  const admin = client(), member = client();
  await admin.demo('admin'); await member.register(); await signPolicies(member);
  const monthly = await plan(admin, 'membership'), pass = await plan(admin, 'day_pass', '15.00');
  assert.deepEqual((await record(admin, member.id)).automaticRoles, []);

  // A scheduled membership already makes them a subscriber.
  let r = await issue(admin, member.id, { planId: monthly.id, startsAt: new Date(Date.now() + 5 * DAY).toISOString() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const membership = r.body.data.id as number;
  let person = await record(admin, member.id);
  assert.deepEqual(person.automaticRoles, ['subscriber']);
  assert.deepEqual(person.roles, ['member'], 'nothing is stored');
  // The directory shows the same label.
  const listed = (await admin.get(`/admin/users?search=${encodeURIComponent((await pool.query('SELECT email FROM "user" WHERE userid=$1', [member.id])).rows[0].email)}`)).body.data.items;
  assert.deepEqual(listed.find((u: { id: number }) => u.id === member.id).automaticRoles, ['subscriber']);

  // On hold: no label; restored: back.
  const status = async (to: string) => {
    const revision = (await pool.query('SELECT revision FROM user_membership WHERE membershipid=$1', [membership])).rows[0].revision;
    const s = await admin.post(`/admin/users/${member.id}/entitlements/membership/${membership}/status`, { status: to, revision, reason: 'Role check' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  };
  await status('suspended');
  assert.deepEqual((await record(admin, member.id)).automaticRoles, []);
  await status('active');
  assert.deepEqual((await record(admin, member.id)).automaticRoles, ['subscriber']);
  // Running out needs no job: the label is gone as soon as the end date passes.
  await pool.query(`UPDATE user_membership SET startdate=(NOW()-INTERVAL '40 days') AT TIME ZONE 'UTC',end_date=(NOW()-INTERVAL '1 second') AT TIME ZONE 'UTC' WHERE membershipid=$1`, [membership]);
  assert.deepEqual((await record(admin, member.id)).automaticRoles, []);

  // A pass for today or later makes them a day-pass customer; a past or cancelled one doesn't.
  r = await issue(admin, member.id, { planId: pass.id, validDate: dayOffset(3) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual((await record(admin, member.id)).automaticRoles, ['day_pass']);
  await pool.query(`UPDATE day_pass SET validdate=$2::date WHERE dayid=$1`, [r.body.data.id, dayOffset(-1)]);
  assert.deepEqual((await record(admin, member.id)).automaticRoles, []);
  await pool.query(`UPDATE day_pass SET validdate=$2::date,status='cancelled' WHERE dayid=$1`, [r.body.data.id, today()]);
  assert.deepEqual((await record(admin, member.id)).automaticRoles, []);
  await pool.query(`UPDATE day_pass SET status='active' WHERE dayid=$1`, [r.body.data.id]);
  assert.deepEqual((await record(admin, member.id)).automaticRoles, ['day_pass']);

  // Neither can be set by hand, as primary or additional role.
  person = await record(admin, member.id);
  for (const body of [{ primaryRole: 'subscriber', roles: ['subscriber'] }, { primaryRole: 'member', roles: ['member', 'day_pass'] }, { role: 'day_pass' }]) {
    r = await admin.post(`/admin/users/${member.id}/role`, { ...body, revision: person.revision, reason: 'Try a purchase role' });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'AUTOMATIC_ROLE');
  }
  // The labels carry no permissions: the member's own access is unchanged.
  assert.deepEqual((await member.get('/auth/session')).body.data.user.roles, ['member']);
});

test('FR-006/FR-008: upgrading drops hand-set purchase roles, keeps one valid primary role and logs it as the system', async () => {
  const admin = client(), customer = client(), staffer = client();
  await admin.demo('admin'); await customer.register(); await staffer.register();
  const assign = async (userId: number, primary: string, roles: string[]) => {
    await pool.query('DELETE FROM user_role WHERE userid=$1', [userId]);
    await pool.query('INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role=ANY($2::text[])', [userId, roles]);
    await pool.query('UPDATE "user" SET primary_role=$2 WHERE userid=$1', [userId, primary]);
  };
  // Hand-set before this change: a subscriber-only account and a staff member also marked day-pass.
  await assign(customer.id, 'subscriber', ['subscriber', 'day_pass']);
  await assign(staffer.id, 'staff', ['staff', 'day_pass']);
  const untouched = (await pool.query('SELECT userid,primary_role,revision FROM "user" WHERE userid=$1', [admin.id])).rows;
  await pool.query("DELETE FROM app_migration WHERE name='062_purchase_roles.sql'");
  await migrate(pool);

  const state = async (userId: number) => (await pool.query(`SELECT u.primary_role AS primary,
    (SELECT array_agg(r.role ORDER BY r.role) FROM user_role ur JOIN role r USING(roleid) WHERE ur.userid=u.userid) AS roles
    FROM "user" u WHERE u.userid=$1`, [userId])).rows[0];
  assert.deepEqual(await state(customer.id), { primary: 'member', roles: ['member'] });
  assert.deepEqual(await state(staffer.id), { primary: 'staff', roles: ['staff'] });
  assert.deepEqual((await pool.query('SELECT userid,primary_role,revision FROM "user" WHERE userid=$1', [admin.id])).rows, untouched);
  const logged = (await pool.query(`SELECT actor_id,subject_id,before_state,after_state FROM app_staff_audit
    WHERE action='user.role_changed' AND subject_id=ANY($1::int[]) ORDER BY subject_id`, [[customer.id, staffer.id]])).rows;
  assert.deepEqual(logged, [
    { actor_id: null, subject_id: customer.id, before_state: { primaryRole: 'subscriber', roles: ['day_pass', 'subscriber'] }, after_state: { primaryRole: 'member', roles: ['member'] } },
    { actor_id: null, subject_id: staffer.id, before_state: { primaryRole: 'staff', roles: ['day_pass', 'staff'] }, after_state: { primaryRole: 'staff', roles: ['staff'] } },
  ].sort((a, b) => a.subject_id - b.subject_id));
  // The fallback account still signs in with a valid primary role.
  const session = await customer.login();
  assert.equal(session.status, 200);
  assert.equal(session.body.data.user.primaryRole, 'member');
  // Running it again changes nothing.
  await pool.query("DELETE FROM app_migration WHERE name='062_purchase_roles.sql'");
  await migrate(pool);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM app_staff_audit WHERE action='user.role_changed' AND subject_id=ANY($1::int[])`, [[customer.id, staffer.id]])).rows[0].n, 2);
});

test('B-003: a desk sale charges a student the student price, shows why, and records it like online checkout', async () => {
  const admin = client(), student = client(), other = client();
  await admin.demo('admin'); await student.register(); await other.register(); await signPolicies(student);
  const monthly = await plan(admin, 'membership', '50.00'), pass = await plan(admin, 'day_pass', '20.00');
  await pool.query('INSERT INTO app_billing_price(tierid,student_cents,partner_free) VALUES($1,3000,false),($2,1200,false)', [monthly.id, pass.id]);
  await pool.query('UPDATE "user" SET is_student=true WHERE userid=$1', [student.id]);
  const startsAt = new Date(Date.now() + 60_000).toISOString();

  // Staff see the price and the reason before taking payment.
  const quote = async (userId: number, query: string) => {
    const r = await admin.get(`/admin/users/${userId}/entitlements/quote?${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };
  assert.deepEqual(await quote(student.id, `planId=${monthly.id}&startsAt=${encodeURIComponent(startsAt)}`),
    { planId: monthly.id, standardCents: 5000, amountCents: 3000, basis: 'student' });
  assert.deepEqual(await quote(student.id, `planId=${pass.id}&validDate=${today()}`),
    { planId: pass.id, standardCents: 2000, amountCents: 1200, basis: 'student' });
  assert.deepEqual(await quote(other.id, `planId=${monthly.id}&startsAt=${encodeURIComponent(startsAt)}`),
    { planId: monthly.id, standardCents: 5000, amountCents: 5000, basis: 'standard' });
  assert.equal((await admin.get(`/admin/users/${student.id}/entitlements/quote?planId=${monthly.id}`)).status, 400);
  assert.equal((await student.get(`/admin/users/${student.id}/entitlements/quote?planId=${monthly.id}&startsAt=${encodeURIComponent(startsAt)}`)).status, 403);

  // A price that changed after staff saw it is refused, not recorded.
  const payments = async (userId: number) => (await pool.query('SELECT price::text,paymentstatus FROM payment WHERE userid=$1 ORDER BY paymentid', [userId])).rows;
  let r = await issue(admin, student.id, { planId: monthly.id, startsAt, expectedAmountCents: 5000 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'PRICE_CHANGED');
  assert.deepEqual(await payments(student.id), []);

  r = await issue(admin, student.id, { planId: monthly.id, startsAt, expectedAmountCents: 3000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.plan.price, '30.00'); assert.equal(r.body.data.plan.priceBasis, 'student');
  const snapshot = (await pool.query('SELECT plan_snapshot FROM user_membership WHERE membershipid=$1', [r.body.data.id])).rows[0].plan_snapshot;
  assert.equal(snapshot.price, '30.00'); assert.equal(snapshot.priceBasis, 'student');
  assert.deepEqual(await payments(student.id), [{ price: '30.00', paymentstatus: 'paid' }]);
  const receipt = (await pool.query(`SELECT payload FROM app_notification_outbox WHERE userid=$1 AND kind='payment_recorded'`, [student.id])).rows;
  assert.equal(receipt.length, 1); assert.equal(receipt[0].payload.amount, '30.00');

  // Waiving still records zero paid; the issued pass keeps the student price it was offered at.
  r = await issue(admin, student.id, { planId: pass.id, validDate: dayOffset(2), paymentStatus: 'waived', method: 'unspecified' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await pool.query('SELECT plan_snapshot FROM day_pass WHERE dayid=$1', [r.body.data.id])).rows[0].plan_snapshot.price, '12.00');
  assert.deepEqual((await payments(student.id)).at(-1), { price: '0.00', paymentstatus: 'waived' });

  // A member who isn't a student pays the standard price at the desk, as before.
  r = await issue(admin, other.id, { planId: monthly.id, startsAt });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await payments(other.id), [{ price: '50.00', paymentstatus: 'paid' }]);
  assert.equal(r.body.data.plan.priceBasis, 'standard');
});

test('B-003: school-partner free access is free at the desk too, only while verified through the access period', async () => {
  const admin = client(), partner = client();
  await admin.demo('admin'); await partner.register();
  const monthly = await plan(admin, 'membership', '50.00');
  await pool.query('INSERT INTO app_billing_price(tierid,student_cents,partner_free) VALUES($1,NULL,true)', [monthly.id]);
  // Verified for only two weeks: a month-long membership isn't covered.
  await pool.query(`INSERT INTO app_partner_eligibility(userid,reference,valid_until,verified_by) VALUES($1,'School letter',$2,$3)`, [partner.id, dayOffset(14), admin.id]);
  const startsAt = new Date(Date.now() + 60_000).toISOString();
  const quoted = await admin.get(`/admin/users/${partner.id}/entitlements/quote?planId=${monthly.id}&startsAt=${encodeURIComponent(startsAt)}`);
  assert.deepEqual(quoted.body.data, { planId: monthly.id, standardCents: 5000, amountCents: 5000, basis: 'standard' });
  await pool.query('UPDATE app_partner_eligibility SET valid_until=$2 WHERE userid=$1', [partner.id, dayOffset(60)]);
  const r = await issue(admin, partner.id, { planId: monthly.id, startsAt, expectedAmountCents: 0 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.plan.priceBasis, 'school_partner');
  assert.deepEqual((await pool.query('SELECT price::text,paymentstatus FROM payment WHERE userid=$1', [partner.id])).rows, [{ price: '0.00', paymentstatus: 'waived' }]);
});
