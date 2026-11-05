import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { transaction } from '../../src/db.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { PassBilling } from '../../src/billing/passes.js';
import { BillingPricing } from '../../src/billing/pricing.js';
import { StudioStripe } from '../../src/studios/stripe.js';
import { StaffService } from '../../src/services/StaffService.js';
import { ReservationService } from '../../src/services/ReservationService.js';
import { evaluateReaderAccess } from '../../src/services/ReaderEligibility.js';
import { accessDeadline } from '../../src/accessDeadline.js';
import { waiverAcceptance, equipmentWaiverName } from '../helpers/waiver.js';

const database = `arbor_day_policies_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
const zone = 'America/New_York';
const provider = new StudioStripe({ key: 'sk_test_fixture', webhookSecret: 'whsec_fixture', origin: 'http://localhost' });
const passes = new PassBilling(pool, provider, zone), pricing = new BillingPricing(pool), staff = new StaffService(pool, zone);
let created = false, app: ReturnType<typeof createApp>, member: any, admin: any, day: any;
let machine: number, ordinaryMachine: number, room: number, providerCalls = 0;
(provider.sdk.checkout.sessions.create as any) = async () => {
  providerCalls++;
  return { id: 'cs_' + randomUUID(), livemode: false, status: 'open', url: 'https://checkout.stripe.com/test' };
};
const get = (path: string, actor = member) => request(app).get('/api' + path).set('Authorization', 'Bearer ' + actor.accessToken);
const post = (path: string, body: object, actor = member) => request(app).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken).send(body);
async function sign(scope: 'facility' | 'equipment') {
  const response = await get('/me/waivers?scope=' + scope);
  assert.equal(response.status, 200);
  for (const waiver of response.body.data)
    assert.equal((await post(`/me/waivers/${waiver.id}/sign`, waiverAcceptance(waiver))).status, 200);
}
async function input(date: string) {
  const offer = (await pricing.offers(member.user.id, date)).find(p => p.id === day.id)!;
  return { planId: day.id, expectedRevision: offer.revision, pricingRevision: offer.pricingRevision, amountCents: offer.amountCents, validDate: date };
}
function manual(date: string) {
  return { requestId: randomUUID(), planId: day.id, startsAt: null, validDate: date,
    paymentStatus: 'paid' as const, method: 'cash', reference: 'TEST', reason: 'Synthetic policy test' };
}
async function financialState() {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM app_pass_checkout) AS checkouts,
    (SELECT count(*) FROM day_pass) AS passes,
    (SELECT count(*) FROM payment) AS payments,
    (SELECT count(*) FROM app_notification_outbox) AS notices`)).rows[0];
}
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: zone });
  member = (await request(app).post('/api/auth/demo').send({ role: 'member' })).body.data;
  admin = (await request(app).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  day = (await pool.query("SELECT tierid AS id FROM membership_tiers WHERE kind='day_pass' AND active LIMIT 1")).rows[0];
  machine = (await pool.query("INSERT INTO equipment(name,status,hourlyrate,waiverrequired) VALUES('Scoped test machine','available',0,true) RETURNING equipmentid")).rows[0].equipmentid;
  ordinaryMachine = (await pool.query("INSERT INTO equipment(name,status,hourlyrate,waiverrequired) VALUES('Ordinary test machine','available',0,false) RETURNING equipmentid")).rows[0].equipmentid;
  room = (await pool.query("INSERT INTO room(name,location,status) VALUES('Scoped test room','Test','available') RETURNING roomid")).rows[0].roomid;
});
beforeEach(async () => {
  if (!created) return;
  await pool.query('DELETE FROM user_waiver WHERE userid=$1', [member.user.id]);
  providerCalls = 0;
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

test('TOS and the supplied specialized agreement have distinct scopes; invalid filters are rejected', async () => {
  const facility = (await get('/me/waivers?scope=facility')).body.data;
  const equipment = (await get('/me/waivers?scope=equipment')).body.data;
  assert.ok(facility.some((w: any) => w.name === 'Terms of Service'));
  assert.ok(facility.every((w: any) => w.scope === 'facility'));
  assert.ok(equipment.some((w: any) => w.name === equipmentWaiverName));
  assert.ok(equipment.every((w: any) => w.scope === 'equipment'));
  assert.equal((await get('/me/waivers?scope=unknown')).status, 400);
  assert.equal((await get('/me/waivers?scope=facility&scope=equipment')).status, 400);
});

test('unsigned facility policies block both online and staff passes before payment, access or notification writes', async () => {
  const before = await financialState(), body = await input('2035-01-10');
  await assert.rejects(passes.checkout(member.user.id, body), { code: 'WAIVER_REQUIRED' });
  const response = await post(`/admin/users/${member.user.id}/entitlements`, manual('2035-01-11'), admin);
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'WAIVER_REQUIRED');
  assert.deepEqual(await financialState(), before); assert.equal(providerCalls, 0);
});

test('facility signatures permit paid and staff-issued day passes without equipment signatures', async () => {
  await sign('facility');
  assert.ok((await get('/me/waivers?scope=equipment')).body.data.every((w: any) => !w.signed));
  assert.ok((await passes.checkout(member.user.id, await input('2035-02-10'))).checkoutUrl);
  assert.equal(providerCalls, 1);
  const response = await post(`/admin/users/${member.user.id}/entitlements`, manual('2035-02-11'), admin);
  assert.equal(response.status, 201, JSON.stringify(response.body));
});

test('free day passes enforce facility signatures without requiring equipment waivers or contacting Stripe', async () => {
  const old = (await pool.query('SELECT tierprice FROM membership_tiers WHERE tierid=$1', [day.id])).rows[0].tierprice;
  await pool.query('UPDATE membership_tiers SET tierprice=0 WHERE tierid=$1', [day.id]);
  try {
    const body = await input('2035-03-10'), before = await financialState();
    await assert.rejects(passes.checkout(member.user.id, body), { code: 'WAIVER_REQUIRED' });
    assert.deepEqual(await financialState(), before);
    await sign('facility');
    assert.deepEqual(await passes.checkout(member.user.id, body), { issued: true });
    assert.equal(providerCalls, 0);
  } finally { await pool.query('UPDATE membership_tiers SET tierprice=$2 WHERE tierid=$1', [day.id, old]); }
});

test('equipment agreements cannot substitute for missing facility configuration', async () => {
  await sign('equipment');
  await pool.query("UPDATE waiver SET isactive=false WHERE policy_scope='facility'");
  try {
    const before = await financialState();
    await assert.rejects(passes.checkout(member.user.id, await input('2035-04-10')), { code: 'WAIVERS_NOT_CONFIGURED' });
    await assert.rejects(staff.issue(admin.user.id, member.user.id, manual('2035-04-11')), { code: 'WAIVERS_NOT_CONFIGURED' });
    assert.deepEqual(await financialState(), before); assert.equal(providerCalls, 0);
  } finally { await pool.query("UPDATE waiver SET isactive=true WHERE policy_scope='facility'"); }
});

test('expired facility signatures still block both day-pass paths', async () => {
  await sign('facility');
  await pool.query("UPDATE user_waiver SET expires_at=now()-interval '1 second' WHERE userid=$1", [member.user.id]);
  const before = await financialState();
  await assert.rejects(passes.checkout(member.user.id, await input('2035-05-10')), { code: 'WAIVER_REQUIRED' });
  await assert.rejects(staff.issue(admin.user.id, member.user.id, manual('2035-05-11')), { code: 'WAIVER_REQUIRED' });
  assert.deepEqual(await financialState(), before); assert.equal(providerCalls, 0);
});

test('equipment waiver enforcement remains at restricted booking and reader access, including leases', async () => {
  await sign('facility');
  const start = new Date(Date.now() + 3 * 3600000), end = new Date(start.getTime() + 3600000);
  const reservations = new ReservationService(pool, zone);
  const body = { equipmentId: machine, startTime: start.toISOString(), endTime: end.toISOString() };
  await assert.rejects(reservations.create(member.user.id, body), { code: 'WAIVER_REQUIRED' });
  await reservations.create(member.user.id, { ...body, equipmentId: ordinaryMachine });
  await sign('equipment');
  await reservations.create(member.user.id, { ...body, startTime: new Date(end.getTime() + 3600000).toISOString(), endTime: new Date(end.getTime() + 2 * 3600000).toISOString() });
  await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'Scoped test',(now()-interval '1 minute') AT TIME ZONE 'UTC',(now()+interval '30 minutes') AT TIME ZONE 'UTC','confirmed')`, [member.user.id, room]);
  await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Scoped test',(now()-interval '1 minute') AT TIME ZONE 'UTC',(now()+interval '30 minutes') AT TIME ZONE 'UTC','confirmed')`, [member.user.id, machine]);
  await pool.query("UPDATE user_waiver SET approval=false WHERE userid=$1 AND waiverid IN(SELECT waiverid FROM waiver WHERE policy_scope='equipment')", [member.user.id]);
  const check = (kind: 'room' | 'equipment', resourceId: number) => transaction(pool, db => evaluateReaderAccess(db, zone, { kind, resourceId }, member.user.id));
  assert.equal((await check('room', room)).allowed, true);
  assert.equal((await check('equipment', machine)).reason, 'WAIVER_REQUIRED');
  await sign('equipment');
  assert.equal((await check('equipment', machine)).allowed, true);
  const at = new Date(), expiry = new Date(at.getTime() + 2500), reservationEnd = new Date(at.getTime() + 3600000);
  await pool.query("UPDATE user_waiver SET expires_at=$2 WHERE userid=$1 AND waiverid IN(SELECT waiverid FROM waiver WHERE policy_scope='equipment')", [member.user.id, expiry]);
  assert.equal((await accessDeadline(pool, zone, member.user.id, reservationEnd, undefined, at)).getTime(), at.getTime() + 5000);
  assert.equal((await accessDeadline(pool, zone, member.user.id, reservationEnd, machine, at)).getTime(), expiry.getTime());
});

test('new versions inherit applicability for older clients, and a new facility version needs fresh acceptance', async () => {
  await sign('facility');
  const terms = (await get('/me/waivers?scope=facility')).body.data.find((w: any) => w.name === 'Terms of Service');
  const publish = (name: string, version: string, scope?: string) => post('/admin/policies', { name, version, scope,
    description: 'Nonbinding scope test wording for integration only.', effectiveAt: new Date(Date.now() - 1000).toISOString(),
    approvalReference: 'Synthetic test reference', reason: 'Test policy applicability' }, admin);
  assert.equal((await publish('Bad scope', '1', 'unknown')).status, 400);
  const equipment = await publish(equipmentWaiverName, 'scope-test');
  assert.equal(equipment.status, 201, JSON.stringify(equipment.body)); assert.equal(equipment.body.data.scope, 'equipment');
  assert.ok((await passes.checkout(member.user.id, await input('2035-06-10'))).checkoutUrl);
  const replacement = await publish('Terms of Service', 'scope-test');
  assert.equal(replacement.status, 201); assert.equal(replacement.body.data.scope, 'facility');
  await assert.rejects(passes.checkout(member.user.id, await input('2035-06-11')), { code: 'WAIVER_REQUIRED' });
  assert.equal((await pool.query('SELECT approval FROM user_waiver WHERE userid=$1 AND waiverid=$2', [member.user.id, terms.id])).rows[0].approval, true);
});
