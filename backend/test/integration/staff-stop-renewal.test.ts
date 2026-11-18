import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { MembershipBilling } from '../../src/billing/service.js';
import { transaction } from '../../src/db.js';
import { AppError } from '../../src/domain.js';
import { enqueueNotification } from '../../src/notifications/store.js';
import { StaffModel, type Plan } from '../../src/models/StaffModel.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';

// A member whose facility access is suspended can't sign in to stop their own card renewal, and staff
// can't open a restricted account, so staff stop it from the member record instead.
const database = 'arbor_stop_renewal_' + randomBytes(6).toString('hex') + '_mvc_test';
const owner = new Pool(), pool = new Pool({ database });
const config = { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true,
  allowedOrigins: ['http://localhost:8080'], timeZone: 'America/New_York' };
const app = createApp(pool, config);
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let created = false, admin: Session, staff: Session, member: Session, plan: Plan;

const as = (who: Session) => ({
  get: (path: string) => request(app).get('/api' + path).set('Authorization', 'Bearer ' + who.accessToken),
  post: (path: string, body: object = {}) => request(app).post('/api' + path).set('Authorization', 'Bearer ' + who.accessToken)
    .set('X-CSRF-Token', who.csrfToken).send(body),
});
async function register(name: string): Promise<Session> {
  const email = `${name}@example.invalid`;
  const input = { firstName: name, lastName: 'Tester', email, phone: '1112223333', dob: '1990-01-01', password: 'GoodPassword123!' };
  assert.equal((await request(app).post('/api/auth/register').send(input)).status, 202);
  return (await request(app).post('/api/auth/confirm').send({ token: await confirmationToken(pool, email) })).body.data;
}
/** A current membership paid by card subscription, as invoice.paid records it. */
async function cardMembership(userId: number, label: string) {
  const model = new StaffModel(pool), from = new Date(Date.now() - 5 * 86400000), to = new Date(Date.now() + 25 * 86400000);
  const membership = await model.createMembership(userId, plan, from.toISOString(), to, admin.user.id, 'Card fixture');
  const payment = await model.createPayment(userId, membership, '50.00', 'paid', 'card', 'in_' + label, 'Card fixture', admin.user.id);
  const billing = randomUUID();
  await pool.query(`INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id)
    VALUES($1,$2,$3,$4,5000,'active',$5,$6)`, [billing, userId, plan.id, plan, 'cus_' + label, 'sub_' + label]);
  await pool.query(`INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end)
    VALUES($1,$2,$3,$4,$5,$6)`, ['in_' + label, billing, membership, payment, from, to]);
  return { membership, billing };
}
const recordOf = async (userId: number, membershipId: number) =>
  (await as(staff).get(`/admin/users/${userId}`)).body.data.memberships.find((m: { id: number }) => m.id === membershipId);
type Renewal = { autoRenews: boolean; renewalEndsAt: string | null; renewalStopPending: boolean };
const renewalOf = async (userId: number, membershipId: number) => {
  const { autoRenews, renewalEndsAt, renewalStopPending }: Renewal = await recordOf(userId, membershipId);
  return { autoRenews, renewalEndsAt: renewalEndsAt && new Date(renewalEndsAt).toISOString(), renewalStopPending };
};
const stopAudits = async (subjectId: number) => (await pool.query(`SELECT actor_id AS "actorId",entity_id AS "entityId",reason
  FROM app_staff_audit WHERE action='billing.renewal_stopped' AND subject_id=$1`, [subjectId])).rows;

/**
 * Stands in for the member's own cancellation, which talks to Stripe: it saves the last day first, then
 * asks the provider. When the provider answers, the stop is confirmed and the member's email is queued;
 * when it doesn't, only the saved day is left behind, and a retry reuses it.
 */
function fakeCancel(ending: Date, providerAnswers = () => true) {
  const calls: unknown[][] = [];
  const method = mock.method(MembershipBilling.prototype, 'cancel', async (userId: number, billingId: string) => {
    calls.push([userId, billingId]);
    await pool.query(`UPDATE app_membership_billing SET cancellation_requested_at=COALESCE(cancellation_requested_at,NOW()),
      cancellation_effective_at=COALESCE(cancellation_effective_at,$2) WHERE id=$1`, [billingId, ending]);
    if (!providerAnswers()) throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'The payment provider didn’t answer. Try again.');
    await transaction(pool, async db => {
      await db.query('UPDATE app_membership_billing SET cancellation_confirmed=true WHERE id=$1', [billingId]);
      await enqueueNotification(db, { userId, kind: 'membership_cancelled', dedupeKey: 'membership-cancel:' + billingId,
        payload: { membershipName: 'Monthly', endsAt: ending.toISOString(), instructions: 'Automatic billing ends on the date shown.' } });
    });
  });
  return { calls, restore: () => method.mock.restore() };
}

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  admin = (await request(app).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  const staffAccount = await register('renewalstaff');
  await pool.query(`INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'`, [staffAccount.user.id]);
  staff = (await request(app).post('/api/auth/login').send({ email: 'renewalstaff@example.invalid', password: 'GoodPassword123!' })).body.data;
  member = await register('renewalmember');
  const tier = (await pool.query("SELECT tierid FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0].tierid;
  plan = (await new StaffModel(pool).plan(tier))!;
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

test('staff stop a suspended member’s card renewal for them, and the record shows it stopped', async () => {
  const { membership, billing } = await cardMembership(member.user.id, 'suspended');
  const revision = (await as(admin).get(`/admin/users/${member.user.id}`)).body.data.user.revision;
  assert.equal((await as(admin).post(`/admin/users/${member.user.id}/access`,
    { status: 'suspended', revision, reason: 'Conduct review' })).status, 200);
  // The member can't sign in to do it themselves, and their account can't be opened.
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'renewalmember@example.invalid', password: 'GoodPassword123!' })).status, 403);
  assert.equal((await as(staff).post('/admin/account-mode', { userId: member.user.id })).status, 403);
  assert.deepEqual(await renewalOf(member.user.id, membership), { autoRenews: true, renewalEndsAt: null, renewalStopPending: false });

  const ending = new Date(Date.now() + 40 * 86400000);
  const cancel = fakeCancel(ending);
  try {
    const stopped = await as(staff).post(`/admin/users/${member.user.id}/memberships/${membership}/stop-renewal`, { reason: 'Member phoned to cancel' });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    // Facility access is suspended but the account is active, so the member's email goes out.
    assert.deepEqual(stopped.body.data, { stopped: true, endsAt: ending.toISOString(), emailed: true });
    // Once the provider confirmed it there is nothing left to stop, and nothing more is logged.
    const again = await as(staff).post(`/admin/users/${member.user.id}/memberships/${membership}/stop-renewal`, { reason: 'Second click' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'RENEWAL_STOPPED');
  } finally { cancel.restore(); }
  assert.deepEqual(cancel.calls, [[member.user.id, billing]]);
  assert.deepEqual(await stopAudits(member.user.id), [{ actorId: staff.user.id, entityId: membership, reason: 'Member phoned to cancel' }]);
  assert.deepEqual(await renewalOf(member.user.id, membership), { autoRenews: false, renewalEndsAt: ending.toISOString(), renewalStopPending: false });
});

test('a stop the provider never confirmed still shows as renewing, and staff can try again', async () => {
  const held = await register('renewalheld');
  const { membership, billing } = await cardMembership(held.user.id, 'held');
  // An account on hold gets no email, so staff are told to pass the date on themselves.
  const revision = (await as(admin).get(`/admin/users/${held.user.id}`)).body.data.user.revision;
  assert.equal((await as(admin).post(`/admin/users/${held.user.id}/status`, { status: 'suspended', revision, reason: 'Account on hold' })).status, 200);
  const path = `/admin/users/${held.user.id}/memberships/${membership}/stop-renewal`;
  const ending = new Date(Date.now() + 35 * 86400000);
  let answers = false;
  const cancel = fakeCancel(ending, () => answers);
  try {
    // The last day is saved, then the call to the provider fails: the subscription still renews.
    assert.equal((await as(staff).post(path, { reason: 'Member phoned to cancel' })).status, 502);
    assert.deepEqual(await stopAudits(held.user.id), []);
    assert.deepEqual(await renewalOf(held.user.id, membership), { autoRenews: true, renewalEndsAt: ending.toISOString(), renewalStopPending: true });

    answers = true;
    const retried = await as(staff).post(path, { reason: 'Trying again' });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual(retried.body.data, { stopped: true, endsAt: ending.toISOString(), emailed: false });
  } finally { cancel.restore(); }
  assert.deepEqual(cancel.calls, [[held.user.id, billing], [held.user.id, billing]]);
  assert.deepEqual(await stopAudits(held.user.id), [{ actorId: staff.user.id, entityId: membership, reason: 'Trying again' }]);
  assert.deepEqual(await renewalOf(held.user.id, membership), { autoRenews: false, renewalEndsAt: ending.toISOString(), renewalStopPending: false });
});

test('ended card billing has no auto-renew to stop', async () => {
  const lapsed = await register('renewallapsed');
  const { membership, billing } = await cardMembership(lapsed.user.id, 'lapsed');
  await pool.query("UPDATE app_membership_billing SET status='canceled' WHERE id=$1", [billing]);
  assert.deepEqual(await renewalOf(lapsed.user.id, membership), { autoRenews: false, renewalEndsAt: null, renewalStopPending: false });
  const cancel = fakeCancel(new Date(Date.now() + 30 * 86400000));
  try {
    const response = await as(staff).post(`/admin/users/${lapsed.user.id}/memberships/${membership}/stop-renewal`, { reason: 'Already ended' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'RENEWAL_STOPPED');
  } finally { cancel.restore(); }
  assert.deepEqual(cancel.calls, []);
  assert.deepEqual(await stopAudits(lapsed.user.id), []);
});

test('stopping renewal needs staff, a reason, CSRF and a card membership of that member', async () => {
  // One open card billing per member: each test bills its own.
  const billed = await register('renewalchecks');
  const { membership } = await cardMembership(billed.user.id, 'checks');
  const other = await register('renewalother');
  const path = `/admin/users/${billed.user.id}/memberships/${membership}/stop-renewal`;
  const cancel = mock.method(MembershipBilling.prototype, 'cancel', async () => {});
  try {
    assert.equal((await as(other).post(path, { reason: 'Not staff' })).status, 403);
    assert.equal((await request(app).post('/api' + path).set('Authorization', 'Bearer ' + staff.accessToken).send({ reason: 'No CSRF' })).status, 403);
    assert.equal((await as(staff).post(path, { reason: '' })).status, 400);
    // Another member's card membership isn't this member's to stop.
    assert.equal((await as(staff).post(`/admin/users/${other.user.id}/memberships/${membership}/stop-renewal`, { reason: 'Wrong member' })).status, 404);
    // A desk-paid membership has no renewal.
    const desk = await new StaffModel(pool).createMembership(other.user.id, plan, new Date().toISOString(),
      new Date(Date.now() + 30 * 86400000), admin.user.id, 'Desk fixture');
    const deskPaid = await as(staff).post(`/admin/users/${other.user.id}/memberships/${desk}/stop-renewal`, { reason: 'Desk paid' });
    assert.equal(deskPaid.status, 404);
    assert.match(deskPaid.body.error.message, /isn’t paid by card/);
    // Only administrators manage staff accounts.
    assert.equal((await as(staff).post(`/admin/users/${admin.user.id}/memberships/${membership}/stop-renewal`, { reason: 'Staff account' })).status, 403);
    assert.equal(cancel.mock.callCount(), 0);
  } finally { cancel.mock.restore(); }
});

test('without card billing configured, staff are told so and nothing is logged', async () => {
  const payer = await register('renewalunconfigured');
  const { membership } = await cardMembership(payer.user.id, 'unconfigured');
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM app_staff_audit WHERE action='billing.renewal_stopped'`)).rows[0].n;
  const response = await as(staff).post(`/admin/users/${payer.user.id}/memberships/${membership}/stop-renewal`, { reason: 'No Stripe here' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'PAYMENTS_UNAVAILABLE');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM app_staff_audit WHERE action='billing.renewal_stopped'`)).rows[0].n, before);
});
