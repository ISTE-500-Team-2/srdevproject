import { confirmationToken } from '../helpers/confirmation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = 'arbor_'+randomBytes(6).toString('hex')+'_mvc_test';
const admin = new Pool({connectionTimeoutMillis:5000});
const pool = new Pool({database,connectionTimeoutMillis:5000});
const app = createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw new Error('Isolated PostgreSQL configuration required');
  await admin.query(`CREATE DATABASE "${database}"`); created=true;
  await initializeDemo(pool);
});
after(async () => {await pool.end();if(created) await admin.query(`DROP DATABASE "${database}"`);await admin.end();});

test('registration queues one event; preference ownership, CSRF, validation and global opt-out work', async () => {
  const registration={firstName:'Notice',lastName:'Tester',email:'notice@example.invalid',phone:'0000000000',dob:'2000-01-01',password:'StrongPassword123!',timeZone:'Pacific/Auckland'};
  let response=await request(app).post('/api/auth/register').send(registration);
  assert.equal(response.status,202);
  response=await request(app).post("/api/auth/confirm").send({token:await confirmationToken(pool,registration.email)});
  assert.equal(response.status,200);
  const {user,csrfToken,accessToken}=response.body.data;
  const agent=request.agent(app).set('Authorization','Bearer '+accessToken);
  assert.deepEqual((await agent.get('/api/me/notifications')).body.data,{enabled:true,timeZone:'Pacific/Auckland'});
  assert.equal((await request(app).get('/api/me/notifications')).status,401);
  assert.equal((await agent.patch('/api/me/notifications').send({enabled:false,timeZone:'UTC'})).status,403);
  assert.equal((await agent.patch('/api/me/notifications').set('X-CSRF-Token',csrfToken).send({enabled:false,timeZone:'bad/zone'})).status,400);
  assert.equal((await request(app).post('/api/auth/register').send(registration)).status,409);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_notification_outbox WHERE userid=$1 AND kind='account_created'",[user.id])).rows[0].n,1);
  assert.equal((await agent.patch('/api/me/notifications').set('X-CSRF-Token',csrfToken).send({enabled:false,timeZone:'UTC',userId:1})).status,200);
  assert.equal((await pool.query("SELECT status FROM app_notification_outbox WHERE userid=$1 AND kind='account_created'",[user.id])).rows[0].status,'suppressed');
  const waivers=(await agent.get('/api/me/waivers')).body.data;
  assert.ok(waivers.length);
  for(let i=0;i<2;i++) assert.equal((await agent.post(`/api/me/waivers/${waivers[0].id}/sign`).set('X-CSRF-Token',csrfToken).send({accepted:true})).status,200);
  const rows=(await pool.query("SELECT status,payload FROM app_notification_outbox WHERE userid=$1 AND kind='waiver_signed'",[user.id])).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'suppressed');
  assert.equal(rows[0].payload.waiverText,waivers[0].description);
  assert.equal(rows[0].payload.waiverVersion,waivers[0].version);
  assert.match(rows[0].payload.signature,/Notice Tester/);
});
