import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_training_price_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({ idleTimeoutMillis: 1000 }), pool = new Pool({ database, idleTimeoutMillis: 1000 });
let server: Server, created = false, admin: any, member: any, machine: any, course: any;
let instructorId: number, roomId: number, registration: any, initialClass: any;
const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(16, 0, 0, 0);
const get = (path: string, actor = member) => request(server).get('/api' + path).set('Authorization', 'Bearer ' + actor.accessToken);
const post = (path: string, body: object = {}, actor = member) => request(server).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken).send(body);
const payment = async (id: number) => (await pool.query('SELECT * FROM payment WHERE paymentid=$1', [id])).rows[0];
const classBody = (day: number) => ({ title: `CNC training ${day}`, certificationId: course.id, instructorId, roomId,
  capacity: 15, startsAt: new Date(+start + day * 86400000).toISOString(),
  endsAt: new Date(+start + day * 86400000 + 3600000).toISOString(), reason: 'Synthetic class pricing fixture' });
async function schedule(day: number) {
  const r = await post('/classes', classBody(day), admin); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data;
}

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  server = createApp(pool, { jwtKey: randomBytes(32), host: '127.0.0.1', port: 8080, secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  admin = (await request(server).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(server).post('/api/auth/demo').send({ role: 'member' })).body.data;
  for (const w of (await get('/me/waivers')).body.data)
    assert.equal((await post(`/me/waivers/${w.id}/sign`, waiverAcceptance(w))).status, 200);
  machine = (await pool.query("SELECT * FROM equipment WHERE name='Joey'")).rows[0];
  course = (await get('/training/catalog', admin)).body.data.find((c: any) => c.id === machine.certid);
  instructorId = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
    VALUES('Pricing','Instructor','class-pricing@example.invalid','unused','0000000000','active') RETURNING userid`)).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'", [instructorId]);
  roomId = (await pool.query("SELECT roomid FROM room WHERE name='Training Room'")).rows[0].roomid;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
  await pool.end(); try { if (created) await owner.query(`DROP DATABASE "${database}"`); } finally { await owner.end(); }
});

test('registration charges the $20 training fee once, including concurrent retries', async () => {
  initialClass = await schedule(0);
  const count = Number((await pool.query('SELECT count(*) FROM payment')).rows[0].count);
  for (const body of [{}, { expectedTrainingFeeCents: 0 }]) {
    const r = await post(`/classes/${initialClass.id}/enroll`, body);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'PRICE_CHANGED');
  }
  assert.equal(Number((await pool.query('SELECT count(*) FROM payment')).rows[0].count), count);
  const responses = await Promise.all([post(`/classes/${initialClass.id}/enroll`, { expectedTrainingFeeCents: 2000 }),
    post(`/classes/${initialClass.id}/enroll`, { expectedTrainingFeeCents: 2000 })]);
  for (const r of responses) assert.equal(r.status, 200, JSON.stringify(r.body));
  registration = responses[0].body.data;
  assert.equal(responses[1].body.data.payment_id, registration.payment_id);
  assert.equal(registration.training_fee_cents, 2000);
  assert.equal((await payment(registration.payment_id)).price, '20.00');
  assert.equal(Number((await pool.query('SELECT count(*) FROM payment')).rows[0].count), count + 1);
  const saved = (await get('/classes')).body.data.find((c: any) => c.id === initialClass.id);
  assert.equal(saved.myTrainingFeeCents, 2000); assert.equal(saved.myPaymentStatus, 'pending');
});

test('withdrawal voids unpaid fees; a paid registration can be rejoined without another charge', async () => {
  assert.equal((await post(`/classes/${initialClass.id}/withdraw`)).status, 200);
  assert.equal((await payment(registration.payment_id)).paymentstatus, 'void');
  const joined = await post(`/classes/${initialClass.id}/enroll`, { expectedTrainingFeeCents: 2000 });
  assert.equal(joined.status, 200); assert.notEqual(joined.body.data.payment_id, registration.payment_id);
  registration = joined.body.data;
  const p = await payment(registration.payment_id);
  assert.equal((await post(`/admin/payments/${registration.payment_id}/status`, { status: 'paid', method: 'cash',
    reference: 'TRAINING-TEST', reason: 'Synthetic payment received', revision: p.revision }, admin)).status, 200);
  assert.equal((await post(`/classes/${initialClass.id}/withdraw`)).status, 200);
  const count = (await pool.query('SELECT count(*) FROM payment')).rows[0].count;
  const rejoined = await post(`/classes/${initialClass.id}/enroll`, { expectedTrainingFeeCents: 2000 });
  assert.equal(rejoined.status, 200); assert.equal(rejoined.body.data.payment_id, registration.payment_id);
  assert.equal((await pool.query('SELECT count(*) FROM payment')).rows[0].count, count);
});

test('class cancellation voids pending training fees and leaves paid fees visible for refund', async () => {
  const pendingClass = await schedule(1);
  const enrolled = await post(`/classes/${pendingClass.id}/enroll`, { expectedTrainingFeeCents: 2000 });
  assert.equal(enrolled.status, 200);
  for (const c of [initialClass, pendingClass])
    assert.equal((await post(`/classes/${c.id}/cancel`, { expectedRevision: c.revision, reason: 'Synthetic cancellation' }, admin)).status, 200);
  assert.equal((await payment(enrolled.body.data.payment_id)).paymentstatus, 'void');
  assert.equal((await payment(registration.payment_id)).paymentstatus, 'paid');
  const listed = (await get('/admin/payments', admin)).body.data.items.find((p: any) => p.id === registration.payment_id);
  assert.match(listed.planName, /Training class:.*refund due/);
});

test('after certification, equipment bookings charge only hours and training registration adds no fee', async () => {
  const approval = await post(`/training/users/${member.user.id}/certifications/${course.id}`, {
    trainedAt: new Date(Date.now() - 3600000).toISOString(), source: 'equipment', verifiedInPerson: true,
    verificationReference: 'Observed CNC training', trainingMinutes: 60, reason: 'Synthetic completed training',
  }, admin);
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  for (const day of [2, 3]) {
    const price = (await get(`/equipment/${machine.equipmentid}/quote?hours=2`)).body.data;
    assert.equal(price.trainingFeeCents, 0); assert.equal(price.totalCents, 5600);
    const r = await post('/reservations', { equipmentId: machine.equipmentid,
      startTime: new Date(+start + day * 86400000).toISOString(), endTime: new Date(+start + day * 86400000 + 2 * 3600000).toISOString(), expectedPrice: price });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await payment(r.body.data.paymentId)).price, '56.00');
  }
  const refresher = await schedule(4), count = (await pool.query('SELECT count(*) FROM payment')).rows[0].count;
  const r = await post(`/classes/${refresher.id}/enroll`, { expectedTrainingFeeCents: 0 });
  assert.equal(r.status, 200); assert.equal(r.body.data.training_fee_cents, 0); assert.equal(r.body.data.payment_id, null);
  assert.equal((await pool.query('SELECT count(*) FROM payment')).rows[0].count, count);
});

test('missing training fee configuration never blocks hourly equipment pricing', async () => {
  await pool.query('UPDATE certifications SET training_fee_cents=NULL WHERE certid=$1', [course.id]);
  const r = await get(`/equipment/${machine.equipmentid}/quote?hours=2`);
  assert.equal(r.status, 200); assert.equal(r.body.data.totalCents, 5600); assert.equal(r.body.data.trainingFeeCents, 0);
});
