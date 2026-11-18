import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { equipmentPrice } from '../../src/equipmentPricing.js';
import { memberRequirements } from '../../src/memberRequirements.js';
import { accessResources, assertReaderTarget } from '../../src/readerRegistry.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = `arbor_catalog_${randomBytes(6).toString('hex')}_mvc_test`;
const owner = new Pool(), pool = new Pool({ database });
const timeZone = 'America/New_York';
type Session = { accessToken: string; csrfToken: string; user: { id: number } };
let app: ReturnType<typeof createApp>, administrator: Session, created = false;

before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone, devices: { cardHashKey: randomBytes(32).toString('hex'), readers: [] } });
  administrator = (await request(app).post('/api/auth/demo').send({ role: 'admin' })).body.data;
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

const fields = (extra: object = {}) => ({ name: `Catalog ${randomBytes(4).toString('hex')}`, type: 'Laser engraver', location: 'Makerspace', image: '', rate: 18.5, certId: null, waiverRequired: true, ...extra });
const add = (body: object) => request(app).post('/api/admin/equipment').set('Authorization', 'Bearer ' + administrator.accessToken).set('X-CSRF-Token', administrator.csrfToken).send(body);
const edit = (id: number, body: object) => request(app).put(`/api/admin/equipment/${id}`).set('Authorization', 'Bearer ' + administrator.accessToken).set('X-CSRF-Token', administrator.csrfToken).send(body);
const options = async () => (await request(app).get('/api/admin/equipment/catalog-options').set('Authorization', 'Bearer ' + administrator.accessToken)).body.data;
const stored = async (id: number) => (await pool.query('SELECT name,category,hourlyrate::text AS rate,certid,availability_revision AS revision FROM equipment WHERE equipmentid=$1', [id])).rows[0];
const machine = async (name: string, category: string, rate: number | null, certId: number | null = null) =>
  (await pool.query('INSERT INTO equipment(name,category,location,hourlyrate,certid,waiverrequired,status) VALUES($1,$2,$3,$4,$5,false,$6) RETURNING equipmentid AS id',
    [name, category, 'Makerspace', rate, certId, 'available'])).rows[0].id as number;
const certification = async (name: string, effective: string, ended: string | null = null) =>
  (await pool.query(`INSERT INTO certifications(certid,name,effectivedate,enddate)
    VALUES((SELECT COALESCE(max(certid),0)+1 FROM certifications),$1,NOW() AT TIME ZONE 'UTC'+$2::interval,NOW() AT TIME ZONE 'UTC'+$3::interval) RETURNING certid AS id`,
    [name, effective, ended])).rows[0].id as number;
const retire = (id: number) => pool.query("INSERT INTO app_equipment_retirement(equipment_id,reason) VALUES($1,'Catalog test')", [id]);

test('new equipment needs a rate booking can charge: free, or a card payment from one hour to a full day', async () => {
  assert.match((await add(fields({ rate: null }))).body.error.message, /Set an hourly rate, or 0/);
  assert.match((await add(fields({ rate: 0.25 }))).body.error.message, /Card payments start at \$0\.50/);
  assert.match((await add(fields({ rate: 4166.67 }))).body.error.message, /\$4,166\.66 an hour or less so a 24-hour booking stays within the \$100,000 limit/);
  for (const rate of [0, 0.5, 4166.66]) {
    const created = await add(fields({ rate }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // The limits are the booking's own: the cheapest and longest bookings both price.
    const hours = rate === 4166.66 ? 24 : 1;
    assert.equal((await equipmentPrice(pool, created.body.data.id, hours))!.totalCents, Math.round(rate * 100) * hours);
  }
});

test('an edit may leave an older rate as it is, but cannot clear a rate or set one booking would refuse', async () => {
  const legacy = await machine('Legacy unpriced lathe', 'Legacy lathe', null);
  const renamed = await edit(legacy, { ...fields({ name: 'Legacy unpriced lathe 2', type: 'Legacy lathe', rate: null }), expectedRevision: 1 });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await stored(legacy)).name, 'Legacy unpriced lathe 2');
  assert.equal((await edit(legacy, { ...fields({ type: 'Legacy lathe', rate: 0.25 }), expectedRevision: 2 })).status, 400);
  const priced = await machine('Priced press', 'Press', 12);
  assert.match((await edit(priced, { ...fields({ name: 'Priced press', type: 'Press', rate: null }), expectedRevision: 1 })).body.error.message, /Set an hourly rate/);
  assert.equal((await stored(priced)).rate, '12.00');
});

test('ended certifications cannot be required; one that starts later can', async () => {
  const ended = await certification('Catalog ended training', '-400 days', '-2 days');
  const later = await certification('Catalog upcoming training', '10 days');
  assert.match((await add(fields({ certId: ended }))).body.error.message, /That certification has ended/);
  const upcoming = await add(fields({ certId: later }));
  assert.equal(upcoming.status, 201, JSON.stringify(upcoming.body));
  // A machine that already required it keeps saving other changes.
  const legacy = await machine('Legacy welder', 'Welder', 15, ended);
  assert.equal((await edit(legacy, { ...fields({ name: 'Legacy welder', type: 'Welder', rate: 16, certId: ended }), expectedRevision: 1 })).status, 200);
  assert.equal((await edit(legacy, { ...fields({ name: 'Legacy welder', type: 'Welder', rate: 16, certId: null }), expectedRevision: 2 })).status, 200);
  assert.equal((await edit(legacy, { ...fields({ name: 'Legacy welder', type: 'Welder', rate: 16, certId: ended }), expectedRevision: 3 })).status, 400);
});

test('a category keeps one spelling, and leaves the list with its last machine', async () => {
  const joined = await add(fields({ type: '  3d PRINTER ' }));
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal((await stored(joined.body.data.id)).category, '3D printer');
  // The only machine in a category may still fix its capitals.
  const lone = await machine('Lone saw', 'band saw', 9);
  assert.equal((await edit(lone, { ...fields({ name: 'Lone saw', type: 'Band saw', rate: 9 }), expectedRevision: 1 })).status, 200);
  assert.equal((await stored(lone)).category, 'Band saw');
  const catalog = await options();
  assert.equal(catalog.categories.filter((c: string) => c.toLowerCase() === '3d printer').length, 1);
  // The demo's removed CNC machine was the only one in its category.
  assert.equal(catalog.categories.includes('CNC machining'), false);
  const printers = catalog.groups.find((g: { name: string }) => g.name === '3D printer');
  assert.ok(printers.machines.some((m: { id: number; image: string; type: string }) => m.id === joined.body.data.id && m.image === '/assets/3d-printer.webp' && m.type === '3D printer'));
  await retire(lone);
  assert.equal((await options()).categories.includes('Band saw'), false);
  // A machine without a category still shows on a member card under its name; the picker doesn't offer it.
  const uncategorized = (await pool.query("INSERT INTO equipment(name,location,hourlyrate,waiverrequired,status) VALUES('ShopBot CNC','Makerspace',20,false,'available') RETURNING equipmentid AS id")).rows[0].id;
  const after = await options();
  assert.ok(after.groups.some((g: { name: string | null; machines: { id: number; type: string }[] }) => g.name === null && g.machines.some(m => m.id === uncategorized && m.type === 'ShopBot CNC')));
  assert.ok(after.categories.every((c: unknown) => typeof c === 'string' && c));
});

test('two machines in a category cannot share a name', async () => {
  await machine('Twin router', 'Router table', 10);
  const duplicate = await add(fields({ name: ' twin ROUTER ', type: 'router table' }));
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error.message, /Another Router table is already called twin ROUTER\. Give this one a different name, like twin ROUTER #2/);
  assert.equal((await add(fields({ name: 'Twin router #2', type: 'Router table' }))).status, 201);
  assert.equal((await add(fields({ name: 'Twin router', type: 'Drill press' }))).status, 201, 'another category may use the name');
  const removed = await machine('Retired twin', 'Router table', 10);
  await retire(removed);
  assert.equal((await add(fields({ name: 'Retired twin', type: 'Router table' }))).status, 201, 'a removed machine frees its name');
});

test('certification options say whether each is in effect and how many members hold it today', async () => {
  const now = await certification('Catalog holders training', '-30 days');
  await certification('Catalog later training', '45 days');
  const users = (await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,accessstatus)
    SELECT 'Holder','Member'||g,'catalog-holder-'||g||'@example.invalid','unused','5550100',CASE WHEN g=4 THEN 'suspended' ELSE 'active' END
    FROM generate_series(1,4) g RETURNING userid`)).rows.map(r => r.userid as number);
  // Three hold it today; one renewal lapsed, one member is suspended.
  await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate)
    SELECT (SELECT COALESCE(max(usercertid),0) FROM user_certifications)+n,u,$2,'active',
      CASE WHEN n=3 THEN NOW() AT TIME ZONE 'UTC'-INTERVAL '1 day' ELSE NOW() AT TIME ZONE 'UTC'+INTERVAL '200 days' END
    FROM unnest($1::int[]) WITH ORDINALITY AS t(u,n)`, [users, now]);
  const certs = (await options()).certifications as { name: string; state: string; startsOn: string | null; holders: number }[];
  const current = certs.find(c => c.name === 'Catalog holders training')!;
  assert.deepEqual([current.state, current.holders], ['now', 2]);
  const later = certs.find(c => c.name === 'Catalog later training')!;
  assert.equal(later.state, 'later');
  assert.match(later.startsOn!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(certs.find(c => c.name === 'Catalog ended training')?.state, 'ended');
});

test('a removed machine is no longer a reader location or a training requirement', async () => {
  const cert = await certification('Catalog removed machine training', '-10 days');
  const removed = await machine('Removed engraver', 'Engraver', 20, cert);
  const kept = await machine('Kept engraver', 'Engraver', 20, cert);
  await retire(removed);
  const resources = (await accessResources(pool)).filter(r => r.kind === 'equipment').map(r => r.id);
  assert.ok(resources.includes(kept));
  assert.equal(resources.includes(removed), false);
  await assert.rejects(assertReaderTarget(pool, 'equipment', removed), /Reader location not found/);
  await assertReaderTarget(pool, 'equipment', kept);
  const member = (await pool.query("SELECT userid FROM \"user\" WHERE email='demo.member@collaboratory.invalid'")).rows[0].userid;
  const { training } = await memberRequirements(pool, timeZone, member);
  assert.ok(training.missing.includes('Kept engraver'));
  assert.equal(training.missing.includes('Removed engraver'), false);
});

test('a save into a category waits for one already in progress there, then sees its machine', async () => {
  const other = await pool.connect();
  try {
    // Another administrator's save into "Race bench" has taken the category's turn and written its machine.
    await other.query('BEGIN');
    await other.query("SELECT pg_advisory_xact_lock(hashtext('arbor-equipment-category'),hashtext(lower($1)))", ['Race bench']);
    await other.query("INSERT INTO equipment(name,category,location,hourlyrate,waiverrequired,status) VALUES('Race saw','Race bench','Makerspace',10,false,'available')");
    const second = add(fields({ name: 'race SAW', type: 'race BENCH' })).then(response => response);
    await new Promise(resolve => setTimeout(resolve, 200));
    await other.query('COMMIT');
    assert.equal((await second).status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM equipment WHERE lower(name)='race saw'")).rows[0].n, 1);
  } finally {
    await other.query('ROLLBACK').catch(() => {});
    other.release();
  }
});

test('older machines that already share a name stay editable as long as the name and category are kept', async () => {
  await machine('Legacy twin', 'Legacy press', 10);
  // Stored before names and categories were trimmed on save.
  const padded = await machine('Legacy twin ', 'legacy press ', 10);
  assert.equal((await edit(padded, { ...fields({ name: 'Legacy twin', type: 'legacy press', rate: 10 }), location: 'Back room', expectedRevision: 1 })).status, 200);
  const other = await machine('legacy TWIN', 'legacy PRESS', 10);
  const moved = await edit(other, { ...fields({ name: 'legacy TWIN', type: 'legacy PRESS', rate: 10 }), location: 'Back room', expectedRevision: 1 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal((await stored(other)).category, 'legacy PRESS', 'an unchanged category keeps its stored spelling');
  assert.equal((await edit(other, { ...fields({ name: 'Legacy twin', type: 'legacy PRESS', rate: 10 }), expectedRevision: 2 })).status, 409, 'a changed name is checked');
});

test('Training cannot newly require an ended certification, and keeps an existing link', async () => {
  const ended = await certification('Catalog ended course', '-400 days', '-1 day');
  const linked = await machine('Already linked mill', 'Mill', 15, ended);
  const unlinked = await machine('Unlinked mill', 'Mill', 15);
  const save = (equipmentIds: number[]) => request(app).patch(`/api/training/catalog/${ended}`).set('Authorization', 'Bearer ' + administrator.accessToken).set('X-CSRF-Token', administrator.csrfToken)
    .send({ name: 'Catalog ended course', description: '', equipmentIds, expectedRevision: 1, reason: 'Catalog test' });
  const refused = await save([linked, unlinked]);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /This certification has ended/);
  assert.equal((await stored(unlinked)).certid, null);
  assert.equal((await save([linked])).status, 200, JSON.stringify(refused.body));
  assert.equal((await stored(linked)).certid, ended);
});

test('a reader cannot be set up on a machine whose removal is in progress', async () => {
  const id = await machine('Racing removal', 'Engraver', 20);
  const remover = await pool.connect(), setup = await pool.connect();
  try {
    // Removal locks the machine, then records it; reader setup arrives in between.
    await remover.query('BEGIN');
    await remover.query('SELECT 1 FROM equipment WHERE equipmentid=$1 FOR UPDATE', [id]);
    await remover.query("INSERT INTO app_equipment_retirement(equipment_id,reason) VALUES($1,'Catalog test')", [id]);
    await setup.query('BEGIN');
    const target = assertReaderTarget(setup, 'equipment', id);
    target.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    await remover.query('COMMIT');
    await assert.rejects(target, /Reader location not found/);
  } finally {
    await setup.query('ROLLBACK').catch(() => {});
    remover.release(); setup.release();
  }
});

test('the options say whether the waivers a waiver-required booking checks are published', async () => {
  assert.equal((await options()).waiversPublished, true, 'the demo publishes both');
  // Booking checks the facility policies and the equipment waivers; either missing fails it.
  for (const scope of ['equipment', 'facility']) {
    await pool.query('UPDATE waiver SET isactive=false WHERE policy_scope=$1', [scope]);
    try { assert.equal((await options()).waiversPublished, false, scope); }
    finally { await pool.query('UPDATE waiver SET isactive=true WHERE policy_scope=$1', [scope]); }
  }
});
