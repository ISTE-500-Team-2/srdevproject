import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { AccessService } from '../../src/services/AccessService.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_waiver_renewal_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const zone = 'America/New_York', DAY = 86_400_000;
let app: ReturnType<typeof createApp>, member: any, created = false;
const get = (path: string) => request(app).get('/api' + path).set('Authorization', 'Bearer ' + member.accessToken);
const post = (path: string, body: object) => request(app).post('/api' + path)
  .set('Authorization', 'Bearer ' + member.accessToken).set('X-CSRF-Token', member.csrfToken).send(body);
type Waiver = { id: number; scope: string; signed: boolean; expiresAt: string | null; description: string; signerName: string };

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Explicit isolated PostgreSQL required.');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { port: 8080, host: '127.0.0.1', secureCookies: false, demoLogin: true, allowedOrigins: [],
    timeZone: zone, jwtKey: randomBytes(32) });
  member = (await request(app).post('/api/auth/demo').send({ role: 'member' })).body.data;
  for (const waiver of (await get('/me/waivers')).body.data as Waiver[])
    if (!waiver.signed) assert.equal((await post(`/me/waivers/${waiver.id}/sign`, waiverAcceptance(waiver))).status, 200);
});
after(async () => {
  await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end();
});

const signatures = async (waiverId: number) => (await pool.query<{ userwaiverid: number; approval: boolean; expires_at: Date }>(
  'SELECT userwaiverid,approval,expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 ORDER BY userwaiverid',
  [member.user.id, waiverId])).rows;

test('a member can sign an expiring waiver again early and then book past the old expiry', async () => {
  const equipment = ((await get('/me/waivers')).body.data as Waiver[]).find(w => w.scope === 'equipment')!;
  assert.ok(equipment?.signed);
  const [first] = await signatures(equipment.id);
  // Ten days left: the expiry reminder has gone out, and a booking in two weeks can't be covered.
  await pool.query("UPDATE user_waiver SET expires_at=NOW()+INTERVAL '10 days' WHERE userwaiverid=$1", [first!.userwaiverid]);
  const access = new AccessService(pool, zone), through = new Date(Date.now() + 14 * DAY);
  await assert.rejects(access.assertEquipmentWaivers(member.user.id, through), { code: 'WAIVER_REQUIRED' });

  const renewed = await post(`/me/waivers/${equipment.id}/sign`, waiverAcceptance(equipment));
  assert.equal(renewed.status, 200, renewed.text);
  const after = await signatures(equipment.id);
  assert.equal(after.length, 2);
  assert.deepEqual(after.map(s => s.approval), [false, true], 'the old signature is superseded, not deleted');
  assert.ok(after[1]!.expires_at.getTime() > Date.now() + 300 * DAY);
  // The new agreement has its own permanent copy; the old one keeps its own.
  const copies = await pool.query('SELECT userwaiverid FROM app_signed_waiver_copy WHERE userwaiverid=ANY($1::int[])',
    [after.map(s => s.userwaiverid)]);
  assert.equal(copies.rowCount, 2);
  await access.assertEquipmentWaivers(member.user.id, through);
  const listed = ((await get('/me/waivers')).body.data as Waiver[]).find(w => w.id === equipment.id)!;
  assert.equal(new Date(listed.expiresAt!).getTime(), after[1]!.expires_at.getTime());

  // Signing again straight away changes nothing: the new signature has most of a year left.
  assert.equal((await post(`/me/waivers/${equipment.id}/sign`, waiverAcceptance(equipment))).status, 200);
  assert.equal((await signatures(equipment.id)).length, 2);
});

test('a signature with months left is not replaced by signing again', async () => {
  const facility = ((await get('/me/waivers')).body.data as Waiver[]).find(w => w.scope === 'facility' && w.signed)!;
  const before = await signatures(facility.id);
  await pool.query("UPDATE user_waiver SET expires_at=NOW()+INTERVAL '60 days' WHERE userwaiverid=$1", [before.at(-1)!.userwaiverid]);
  assert.equal((await post(`/me/waivers/${facility.id}/sign`, waiverAcceptance(facility))).status, 200);
  const after = await signatures(facility.id);
  assert.equal(after.length, before.length);
  assert.equal(after.at(-1)!.approval, true);
});
