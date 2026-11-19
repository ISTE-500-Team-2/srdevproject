import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { memberRequirements } from '../../src/memberRequirements.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_equipment_hidden_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({ idleTimeoutMillis: 1000 }), pool = new Pool({ database, idleTimeoutMillis: 1000 });
const timeZone = 'America/New_York';
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let server: Server, created = false, admin: Session, member: Session, machine: number, trained: number;
const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(16, 0, 0, 0);
const slot = (days: number, id = machine) => ({ equipmentId: id,
  startTime: new Date(+start + days * 86400000).toISOString(), endTime: new Date(+start + days * 86400000 + 3600000).toISOString() });
const get = (path: string, actor = member) => request(server).get('/api' + path).set('Authorization', 'Bearer ' + actor.accessToken);
const post = (path: string, body: object = {}, actor = member) => request(server).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken).set('X-Account-Subject', String(actor.user.id)).send(body);
const revision = async (id = machine) => (await pool.query<{ r: number }>('SELECT availability_revision AS r FROM equipment WHERE equipmentid=$1', [id])).rows[0]!.r;
const setHidden = async (hidden: boolean, id = machine, actor = admin) => post(`/admin/equipment/${id}/visibility`, { hidden, expectedRevision: await revision(id) }, actor);
const listed = async (path: string, actor: Session, id = machine) => (await get(path, actor)).body.data.find((e: { id: number }) => e.id === id);
const quote = (actor: Session, id = machine) => get(`/equipment/${id}/quote?hours=1`, actor);

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  const app = createApp(pool, { jwtKey: randomBytes(32), host: '127.0.0.1', port: 8080, secureCookies: false, demoLogin: true, allowedOrigins: [], timeZone });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  admin = (await request(server).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(server).post('/api/auth/demo').send({ role: 'member' })).body.data;
  for (const w of (await get('/me/waivers')).body.data) assert.equal((await post(`/me/waivers/${w.id}/sign`, waiverAcceptance(w))).status, 200);
  // Rachel needs no training, so the demo member can book her; Joey needs training.
  machine = (await pool.query("SELECT equipmentid FROM equipment WHERE name='Rachel'")).rows[0].equipmentid;
  trained = (await pool.query("SELECT equipmentid FROM equipment WHERE name='Joey'")).rows[0].equipmentid;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
  await pool.end(); try { if (created) await owner.query(`DROP DATABASE "${database}"`); } finally { await owner.end(); }
});

test('a hidden machine leaves the member catalog but keeps its bookings; staff still see and book it', async () => {
  const price = (await quote(member)).body.data;
  const kept = await post('/reservations', { ...slot(0), expectedPrice: price });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));

  const hidden = await setHidden(true);
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.data.hidden, true);
  const audit = (await pool.query("SELECT actor_id,before_state,after_state FROM app_staff_audit WHERE action='equipment.hidden' AND entity_id=$1", [machine])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, admin.user.id);
  assert.equal(audit[0].before_state.hidden, false);
  assert.equal(audit[0].after_state.hidden, true);

  // Members: not listed (even when asking for hidden ones), not priced, not bookable.
  assert.equal(await listed('/equipment', member), undefined);
  assert.equal(await listed('/equipment?include=hidden', member), undefined);
  assert.equal((await quote(member)).status, 404);
  const refused = await post('/reservations', { ...slot(1), expectedPrice: price });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'NOT_FOUND');

  // The booking made before stays, and the member can still cancel it.
  assert.ok((await get('/reservations')).body.data.some((r: { id: number }) => r.id === kept.body.data.id));

  // Staff: the member catalog page matches what members see; staff pages ask for hidden machines.
  assert.equal(await listed('/equipment', admin), undefined);
  assert.equal((await listed('/equipment?include=hidden', admin)).hidden, true);
  assert.equal((await get('/admin/equipment', admin)).body.data.find((e: { id: number }) => e.id === machine).hidden, true);
  assert.equal((await get(`/admin/equipment/${machine}`, admin)).body.data.hidden, true);
  assert.equal((await quote(admin)).status, 200);
  const forMember = await post('/reservations', { ...slot(2), userId: member.user.id, expectedPrice: price }, admin);
  assert.equal(forMember.status, 201, JSON.stringify(forMember.body));

  assert.equal((await post(`/reservations/${kept.body.data.id}/cancel`)).status, 200);
});

test('showing it again returns it to members', async () => {
  const shown = await setHidden(false);
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_staff_audit WHERE action='equipment.shown' AND entity_id=$1", [machine])).rows[0].n, 1);
  assert.equal((await listed('/equipment', member)).hidden, false);
  const price = (await quote(member)).body.data;
  assert.equal((await post('/reservations', { ...slot(4), expectedPrice: price })).status, 201);
});

test('only administrators change visibility, against the current revision, and only to a new state', async () => {
  assert.equal((await setHidden(true, machine, member)).status, 403);
  assert.equal((await post(`/admin/equipment/${machine}/visibility`, { hidden: true, expectedRevision: await revision() - 1 }, admin)).status, 409);
  assert.equal((await post(`/admin/equipment/${machine}/visibility`, { hidden: 'yes', expectedRevision: await revision() }, admin)).status, 400);
  const again = await setHidden(false);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_STATUS');
  assert.equal((await pool.query('SELECT hidden FROM equipment WHERE equipmentid=$1', [machine])).rows[0].hidden, false);
});

test('member requirements leave out training for hidden machines', async () => {
  const joey = (await pool.query("SELECT name FROM equipment WHERE equipmentid=$1", [trained])).rows[0].name;
  assert.ok((await memberRequirements(pool, timeZone, member.user.id)).training.missing.includes(joey));
  assert.equal((await setHidden(true, trained)).status, 200);
  assert.equal((await memberRequirements(pool, timeZone, member.user.id)).training.missing.includes(joey), false);
});
