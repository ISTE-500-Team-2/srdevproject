import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { renderNotification } from '../../src/notifications/templates.js';
import { updateNotificationPreferences } from '../../src/notifications/store.js';
import { equipmentWaiverName, waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_${randomBytes(6).toString('hex')}_form_mvc_test`;
const owner = new Pool({ connectionTimeoutMillis: 5000 });
const pool = new Pool({ database, connectionTimeoutMillis: 5000 });
let created = false;
let app: ReturnType<typeof createApp>;
let member: any, admin: any, waiver: any;
const get = (path: string, actor = member) => request(app).get(`/api${path}`).set('Authorization', `Bearer ${actor.accessToken}`);
const post = (path: string, body: unknown, actor = member) => request(app).post(`/api${path}`)
  .set('Authorization', `Bearer ${actor.accessToken}`).set('X-CSRF-Token', actor.csrfToken).send(body);
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  app = createApp(pool, { jwtKey: randomBytes(32), port: 8080, host: '127.0.0.1', secureCookies: false,
    demoLogin: true, allowedOrigins: [], timeZone: 'America/New_York' });
  member = (await request(app).post('/api/auth/demo').send({ role: 'member' })).body.data;
  admin = (await request(app).post('/api/auth/demo').send({ role: 'admin' })).body.data;
  waiver = (await get('/me/waivers')).body.data.find((w: any) => w.name === equipmentWaiverName);
});
after(async () => { await pool.end(); if (created) await owner.query(`DROP DATABASE "${database}"`); await owner.end(); });

test('unsigned users receive the waiver with a field for all 19 blanks, without a form key', async () => {
  assert.ok(waiver);
  assert.equal(waiver.signed, false);
  assert.equal(waiver.formFields.length, 19);
  // The form says whose name the signature must match; identity and timing are server fields.
  assert.equal(waiver.signerName, `${member.user.firstName} ${member.user.lastName}`);
  assert.deepEqual(waiver.formFields.filter((f: any) => f.section === 'administrative').map((f: any) => f.source), ['server', 'server', 'server', 'server']);
  assert.equal((await get('/me/signed-waivers')).body.data.length, 0);
  assert.ok((await get('/me/waivers')).body.data.some((w: any) => w.name === 'Terms of Service'));
});

test('missing, invalid and unrecognized form entries cannot create a signature', async () => {
  const sign = (body: unknown) => post(`/me/waivers/${waiver.id}/sign`, body);
  const body = waiverAcceptance(waiver);
  assert.equal((await sign({ accepted: true })).status, 400);
  assert.equal((await sign({ ...body, accepted: false })).status, 400);
  for (const label of ['Participant Signature', 'Date of Birth', 'Emergency Contact Name']) {
    const field = waiver.formFields.find((f: any) => f.label === label);
    assert.equal((await sign({ ...body, formValues: { ...body.formValues, [field.key]: '' } })).status, 400);
  }
  assert.equal((await sign({ ...body, formValues: { ...body.formValues, forgedMemberId: '99' } })).status, 400);
  // Server-recorded fields can't be supplied, even under their real keys.
  for (const label of ['User/Member ID', 'Waiver Version', 'Accepted Date/Time', 'Participant Name']) {
    const field = waiver.formFields.find((f: any) => f.label === label);
    const forged = await sign({ ...body, formValues: { ...body.formValues, [field.key]: 'forged' } });
    assert.equal(forged.status, 400, label);
  }
  const signature = waiver.formFields.find((f: any) => f.label === 'Participant Signature');
  const mismatch = await sign({ ...body, formValues: { ...body.formValues, [signature.key]: 'Somebody Else' } });
  assert.equal(mismatch.status, 400);assert.equal(mismatch.body.error.code, 'SIGNATURE_MISMATCH');
  const guardian = waiver.formFields.find((f: any) => f.section === 'guardian');
  assert.equal((await sign({ ...body, guardianConsent: true, formValues: { ...body.formValues, [guardian.key]: '' } })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_waiver WHERE userid=$1 AND waiverid=$2', [member.user.id, waiver.id])).rows[0].n, 0);
});

test('completed values survive signing, retries, document edits, email opt-out and copy retrieval', async () => {
  await updateNotificationPreferences(pool, member.user.id, { enabled: false, timeZone: 'America/New_York' });
  const body = waiverAcceptance(waiver);
  assert.equal((await post(`/me/waivers/${waiver.id}/sign`, body)).status, 200);
  const record = (await get('/me/signed-waivers')).body.data.find((w: any) => w.waiverId === waiver.id);
  const { payload, status } = (await pool.query('SELECT payload,status FROM app_notification_outbox WHERE dedupe_key=$1', [`waiver-signed:${record.id}`])).rows[0];
  assert.equal(status, 'suppressed');
  assert.equal(payload.memberId, member.user.id);
  assert.equal(payload.waiverText, waiver.description);
  const name = `${member.user.firstName} ${member.user.lastName}`;
  assert.ok(payload.completedWaiverText.includes(`Participant Signature: ${name}`));
  assert.ok(payload.completedWaiverText.includes(`Participant Name: ${name}`));
  assert.ok(payload.completedWaiverText.includes(`User/Member ID: ${member.user.id}`));
  assert.ok(payload.completedWaiverText.includes(`Waiver Version: ${waiver.version}`));
  assert.match(payload.completedWaiverText, /Accepted Date\/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(America\/New_York\)/);
  assert.match(payload.completedWaiverText, /Emergency Contact Phone: \+1 \(555\) 010-1234/);
  assert.doesNotMatch(payload.completedWaiverText, /_{3,}/);
  const copy = (await get(`/me/signed-waivers/${record.id}/copy`)).body.data.content;
  assert.ok(copy.includes(payload.completedWaiverText));
  assert.equal((await get(`/me/signed-waivers/${record.id}/copy`, admin)).status, 404);
  assert.equal((await get(`/admin/users/${member.user.id}/signed-waivers/${record.id}/copy`, admin)).status, 200);
  const email = renderNotification('waiver_signed', payload, { recipientEmail: member.user.email, senderName: 'The Collaboratory', senderEmail: 'studio@example.invalid', postalAddress: 'Test address' });
  assert.ok(email.textContent.includes(payload.completedWaiverText));
  assert.match(email.htmlContent, /Emergency Contact Phone: \+1 \(555\) 010-1234/);
  assert.equal((await post(`/me/waivers/${waiver.id}/sign`, body)).status, 200);
  await pool.query("UPDATE waiver SET description='Changed current text' WHERE waiverid=$1", [waiver.id]);
  assert.equal((await get(`/me/signed-waivers/${record.id}/copy`)).body.data.content, copy);
  await pool.query('UPDATE waiver SET description=$2 WHERE waiverid=$1', [waiver.id, waiver.description]);
});

test('replacement wording automatically exposes new blanks and retains selected guardian values', async () => {
  // A new member blank in the participant section; blanks after "Administrative Record" are server-filled.
  const description = waiver.description.replace(/(Emergency Contact Phone: _+)/, '$1\nAdditional information: ______');
  assert.notEqual(description, waiver.description);
  const next = await post('/admin/policies', { name: waiver.name, version: 'form-test-v2', description,
    effectiveAt: new Date(Date.now() - 1000).toISOString(), approvalReference: 'Isolated test source', reason: 'Test form version replacement' }, admin);
  assert.equal(next.status, 201, JSON.stringify(next.body));
  const current = (await get('/me/waivers')).body.data.find((w: any) => w.name === waiver.name);
  assert.equal(current.formFields.length, 20);
  assert.equal(current.signed, false);
  const body = waiverAcceptance(current, true);
  assert.equal((await post(`/me/waivers/${current.id}/sign`, body)).status, 200);
  const signed = (await get('/me/signed-waivers')).body.data.find((w: any) => w.waiverId === current.id);
  const copy = (await get(`/me/signed-waivers/${signed.id}/copy`)).body.data.content;
  assert.match(copy, /Parent\/Guardian Signature: Waiver Test Participant/);
  assert.match(copy, /Relationship to Participant: Parent/);
  assert.match(copy, /Additional information: Waiver Test Participant/);
});
