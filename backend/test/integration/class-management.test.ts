import assert from 'node:assert/strict';
import { dataUrl, jpeg } from '../helpers/photos.js';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = `arbor_class_management_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({ idleTimeoutMillis: 1000 }), pool = new Pool({ database, idleTimeoutMillis: 1000 });
let server: Server, created = false, admin: any, member: any;
let workshop: number, trainingRoom: number, _projectRoom: number, first: number, _second: number;
const HOUR = 3600000, DAY = 24 * HOUR;
// 16:00 UTC is the same calendar day in New York, the facility's zone.
const day = new Date(Date.now() + 3 * DAY); day.setUTCHours(16, 0, 0, 0);
const at = (hours: number) => new Date(+day + hours * HOUR).toISOString();
const get = (path: string, actor = member) => request(server).get('/api' + path).set('Authorization', 'Bearer ' + actor.accessToken);
const post = (path: string, body: object = {}, actor = admin) => request(server).post('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken)
  .set('X-Account-Subject', String(actor.user.id)).send(body);
const put = (path: string, body: object, actor = admin) => request(server).put('/api' + path)
  .set('Authorization', 'Bearer ' + actor.accessToken).set('X-CSRF-Token', actor.csrfToken)
  .set('X-Account-Subject', String(actor.user.id)).send(body);
const body = (extra: object) => ({ title: 'Resin night', catalogId: workshop, instructorId: first, roomId: trainingRoom,
  capacity: 6, startsAt: at(0), endsAt: at(2), reason: 'Scheduling rules fixture', ...extra });
async function schedule(extra: object) {
  const r = await post('/classes', body(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function instructor(email: string) {
  const id = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status)
    VALUES('Class','Instructor',$1,'unused','0000000000','active') RETURNING userid`, [email])).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'", [id]);
  return id as number;
}
const room = async (name: string, capacity: number | null) => (await pool.query(
  "INSERT INTO room(name,location,status,capacity) VALUES($1,'Fixture','available',$2) RETURNING roomid", [name, capacity])).rows[0].roomid as number;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true; await initializeDemo(pool);
  server = createApp(pool, { jwtKey: randomBytes(32), host: '127.0.0.1', port: 8080, secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  admin = (await request(server).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  member = (await request(server).post('/api/auth/demo').send({ role: 'member' })).body.data;
  workshop = (await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
  trainingRoom = (await pool.query("SELECT roomid FROM room WHERE name='Training Room'")).rows[0].roomid;
  _projectRoom = (await pool.query("SELECT roomid FROM room WHERE name='Project Room A'")).rows[0].roomid;
  first = await instructor('class-rules-first@example.invalid');
  _second = await instructor('class-rules-second@example.invalid');
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
  await pool.end(); try { if (created) await owner.query(`DROP DATABASE "${database}"`); } finally { await owner.end(); }
});


const fields = { title: 'New glass workshop', description: 'Make glass art', capacity: 8, image: '/assets/resin-glass-art.webp' };
test('catalog changes are permission checked, revisioned, audited and used for new sessions', async () => {
  assert.equal((await post('/classes/catalog', fields, member)).status, 403);
  const created = await post('/classes/catalog', fields);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = created.body.data;
  const duplicate = await post('/classes/catalog', fields);
  assert.equal(duplicate.status, 409);
  const changed = await put(`/classes/catalog/${item.id}`, { ...fields, title: 'Updated glass workshop', expectedRevision: item.revision });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await put(`/classes/catalog/${item.id}`, { ...fields, expectedRevision: item.revision })).status, 409);
  const listing = await get('/classes/catalog');
  assert.equal(listing.body.data.find((c: any) => c.id === item.id).image, fields.image);
  const session = await schedule({ catalogId: item.id, title: 'Glass session' });
  assert.equal(session.imagepath, fields.image);
  assert.equal(session.description, fields.description);
  assert.ok((await pool.query("SELECT 1 FROM app_staff_audit WHERE action='class.catalog_created' AND entity_id=$1", [String(item.id)])).rowCount);
});
test('session edits protect enrollment, room capacity, revisions and closed sessions', async () => {
  const session = await schedule({ startsAt: at(10), endsAt: at(12), title: 'Editable session' });
  await pool.query("INSERT INTO app_training_enrollment(class_id,user_id) VALUES($1,$2)", [session.id, member.user.id]);
  const payload = { ...fields, expectedRevision: session.revision };
  assert.equal((await put(`/classes/${session.id}`, payload, member)).status, 403);
  assert.equal((await put(`/classes/${session.id}`, { ...payload, capacity: 16 })).status, 400);
  // Two people already hold seats; shrinking the roster must not remove either one.
  await pool.query("INSERT INTO app_training_enrollment(class_id,user_id) VALUES($1,$2)", [session.id, admin.user.id]);
  const tooSmall = await put(`/classes/${session.id}`, { ...payload, capacity: 1 });
  assert.equal(tooSmall.body.error.code, 'ROSTER_TOO_SMALL');
  const saved = await put(`/classes/${session.id}`, { ...payload, capacity: 5 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.revision, session.revision + 1);
  assert.equal((await put(`/classes/${session.id}`, payload)).status, 409);
  const row = (await get('/classes')).body.data.find((c: any) => c.id === session.id);
  assert.equal(row.title, fields.title); assert.equal(row.description, fields.description); assert.equal(row.image, fields.image); assert.equal(row.capacity, 5);
  await post(`/classes/${session.id}/cancel`, { expectedRevision: saved.body.data.revision, reason: 'Test closed editor' });
  assert.equal((await put(`/classes/${session.id}`, { ...payload, expectedRevision: saved.body.data.revision + 1 })).status, 409);
  const smallRoom = await room('Two seat room', 2);
  const small = await schedule({ roomId: smallRoom, capacity: 2, startsAt: at(20), endsAt: at(22) });
  assert.equal((await put(`/classes/${small.id}`, { ...payload, expectedRevision: small.revision, capacity: 3 })).status, 400);
});
test('invalid image input is rejected and an uploaded image is served', async () => {
  assert.equal((await post('/classes/catalog', { ...fields, title: 'Bad image', image: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post('/classes/catalog', { ...fields, title: 'Bad upload', imageUpload: 'data:text/html;base64,WA==' })).status, 400);
  const photo = jpeg(640, 480);
  const created = await post('/classes/catalog', { ...fields, title: 'Uploaded art', imageUpload: dataUrl('image/jpeg', photo) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const image = await request(server).get(created.body.data.imagepath);
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.deepEqual(image.body, photo);
});

test('catalog removal is permission and revision checked, and preserves existing sessions', async () => {
  const created = await post('/classes/catalog', { ...fields, title: 'Removable workshop' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const item = created.body.data;
  const session = await schedule({ catalogId: item.id, startsAt: at(50), endsAt: at(52) });
  const remove = (revision: number, actor = admin, csrf = true) => {
    const r = request(server).delete(`/api/classes/catalog/${item.id}`)
      .set('Authorization', 'Bearer ' + actor.accessToken).set('X-Account-Subject', String(actor.user.id));
    if (csrf) r.set('X-CSRF-Token', actor.csrfToken);
    return r.send({ expectedRevision: revision });
  };
  assert.equal((await remove(item.revision, member)).status, 403);
  assert.equal((await remove(item.revision, admin, false)).status, 403);
  assert.equal((await remove(item.revision + 1)).status, 409);
  assert.equal((await remove(item.revision)).status, 200);
  assert.ok(!(await get('/classes/catalog')).body.data.some((c: any) => c.id === item.id));
  assert.ok((await get('/classes')).body.data.some((c: any) => c.id === session.id));
  assert.ok((await pool.query('SELECT removed_at FROM app_class_catalog WHERE id=$1', [item.id])).rows[0].removed_at);
  assert.equal((await put(`/classes/catalog/${item.id}`, { ...fields, expectedRevision: item.revision + 1 })).status, 404);
  const rejected = await post('/classes', body({ catalogId: item.id, startsAt: at(60), endsAt: at(62) }));
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, 'INVALID_CLASS');
  assert.ok((await pool.query("SELECT 1 FROM app_staff_audit WHERE action='class.catalog_removed' AND entity_id=$1", [item.id])).rowCount);
});
