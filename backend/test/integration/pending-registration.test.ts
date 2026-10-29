import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';
import { runNotificationBatch } from '../../src/notifications/worker.js';
import { pruneRegistrations } from '../../src/confirmation/pendingRegistration.js';

// These tests use isolated database rows and a fake email sender, never real member inboxes.
const database='arbor_registration_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'};
const app=createApp(pool,config);
let created=false;
before(async()=>{if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PG required');await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
const person=(email:string)=>({firstName:'Pending',lastName:'Test',email,phone:'0000000000',dob:'2000-01-01',password:'ValidPassword!'});
const register=(email:string)=>request(app).post('/api/auth/register').send(person(email));

test('garbage email formats cannot create users, staged requests or email jobs',async()=>{
  const separate=createApp(pool,config);
  const before=(await pool.query('SELECT COUNT(*)::int AS n FROM app_pending_registration')).rows[0].n;
  for(const email of ['bad','a..b@example.com','.a@example.com','a.@example.com','a@-host.com','a@host_.com','a@host..com','a@host.c','a@host.123'])
    assert.equal((await request(separate).post('/api/auth/register').send(person(email))).status,400,email);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_pending_registration')).rows[0].n,before);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM "user"')).rows[0].n,2);
});

test('signup stages an expiring request with no member, role, preference or session; confirmation creates exactly one account',async()=>{
  const input=person('staged@example.invalid');
  assert.equal((await request(app).post('/api/auth/register').send({...input,username:'ignored_username'})).status,202);
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1',[input.email])).rowCount,0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM user_role')).rows[0].n,2);
  const staged=(await pool.query('SELECT * FROM app_pending_registration WHERE email=$1',[input.email])).rows[0];
  assert.notEqual(staged.password_hash,input.password);
  assert.ok(Math.abs(staged.expires_at-staged.created_at-86400000)<3000);
  assert.equal((await request(app).post('/api/auth/login').send(input)).body.error.code,'EMAIL_CONFIRMATION_REQUIRED');
  assert.equal((await request(app).post('/api/auth/login').send({...input,password:'WrongPassword!'})).status,401);
  await request(app).post('/api/auth/password-reset').send({email:input.email});
  assert.equal((await pool.query('SELECT 1 FROM app_password_reset')).rowCount,0);
  const token=await confirmationToken(pool,input.email);
  const results=await Promise.all([1,2].map(()=>request(app).post('/api/auth/confirm').send({token})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  const member=results.find(r=>r.status===200)!.body.data;
  assert.equal(member.user.username,null);
  assert.ok(member.user.roles.includes('member'));
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',[input.email])).rowCount,0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM "user" WHERE email=$1',[input.email])).rows[0].n,1);
});

test('duplicate requests cannot replace passwords or spam an inbox, while authenticated resends rotate links',async()=>{
  const input=person('repeated@example.invalid');await register(input.email);
  const old=await confirmationToken(pool,input.email);
  assert.equal((await request(app).post('/api/auth/register').send({...input,password:'DifferentPassword!'})).status,202);
  assert.equal(await confirmationToken(pool,input.email),old);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_notification_outbox WHERE registration_id=(SELECT id FROM app_pending_registration WHERE email=$1)',[input.email])).rows[0].n,1);
  assert.equal((await request(app).post('/api/auth/confirmation').send({...input,newEmail:'corrected@example.invalid'})).status,429);
  await pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=$1",[input.email]);
  assert.equal((await request(app).post('/api/auth/confirmation').send({...input,newEmail:'corrected@example.invalid'})).status,202);
  assert.equal((await request(app).post('/api/auth/confirm').send({token:old})).status,400);
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1',['corrected@example.invalid'])).rowCount,0);
  assert.notEqual(await confirmationToken(pool,'corrected@example.invalid'),old);
});

test('the email worker sends staged confirmation without activating a member and expired requests are purged',async()=>{
  await register('worker@example.invalid');
  const sent:string[]=[];
  const result=await runNotificationBatch(pool,async job=>{sent.push(job.email);return{messageId:'test-'+sent.length};});
  assert.ok(result.accepted>=1);assert.ok(sent.includes('worker@example.invalid'));
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1',['worker@example.invalid'])).rowCount,0);
  const token=await confirmationToken(pool,'worker@example.invalid');
  await pool.query("UPDATE app_pending_registration SET expires_at=NOW()-INTERVAL '1 second' WHERE email=$1",['worker@example.invalid']);
  assert.equal((await request(app).post('/api/auth/confirm').send({token})).status,400);
  await pruneRegistrations(pool);
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',['worker@example.invalid'])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM app_notification_outbox WHERE payload->>\'confirmationUrl\' LIKE $1',['%'+token])).rowCount,0);
});

test('public signup has an independent ten-attempt IP limit',async()=>{
  const limited=createApp(pool,config);
  for(let i=0;i<10;i++)assert.equal((await request(limited).post('/api/auth/register').send({})).status,400);
  const response=await request(limited).post('/api/auth/register').send(person('limited@example.invalid'));
  assert.equal(response.status,429);assert.ok(response.headers['retry-after']);
});

// Real API/database flows must agree on address identity without removing meaningful dots or plus tags.
test('signup, duplicates, correction, delivery, login and password recovery share email identity rules',async()=>{
  const flow=createApp(pool,config);
  const initial='first.last+studio@example.com', corrected='first.last+workshop@example.com';
  const input=person(' First.Last+Studio@Example.COM ');
  assert.equal((await request(flow).post('/api/auth/register').send(input)).status,202);
  const old=await confirmationToken(pool,initial);
  assert.equal((await request(flow).post('/api/auth/register').send({...input,email:initial.toUpperCase()})).status,202);
  assert.equal(await confirmationToken(pool,initial),old);
  await pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=$1",[initial]);
  assert.equal((await request(flow).post('/api/auth/confirmation').send({...input,newEmail:' First.Last+Workshop@Example.COM '})).status,202);
  assert.equal((await request(flow).post('/api/auth/confirm').send({token:old})).status,400);
  const recipients:string[]=[];
  await runNotificationBatch(pool,async job=>{recipients.push(job.email);return{messageId:'identity-'+randomBytes(6).toString('hex')};});
  assert.ok(recipients.includes(corrected));
  const confirmed=await request(flow).post('/api/auth/confirm').send({token:await confirmationToken(pool,corrected)});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.data.user.email,corrected);
  const id=confirmed.body.data.user.id;
  const login=await request(flow).post('/api/auth/login').send({identifier:' First.Last+Workshop@Example.COM ',password:input.password});
  assert.equal(login.status,200);assert.equal(login.body.data.user.id,id);
  assert.equal((await request(flow).post('/api/auth/password-reset').send({email:' FIRST.LAST+WORKSHOP@EXAMPLE.COM '})).status,202);
  assert.equal((await pool.query('SELECT 1 FROM app_password_reset WHERE userid=$1',[id])).rowCount,1);
  const reset=(await pool.query("SELECT payload FROM app_notification_outbox WHERE userid=$1 AND kind='password_reset' ORDER BY id DESC LIMIT 1",[id])).rows[0];
  assert.equal((await request(flow).post('/api/auth/password-reset/check').send({token:new URL(reset.payload.resetUrl).hash.slice(1)})).status,204);
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=ANY($1::text[])',[[initial,'firstlast@example.com','first.last@example.com']])).rowCount,0);
});

// Malformed input must be rejected consistently at every entry point before records or notification jobs change.
test('all email account endpoints reject injection, invisible characters and malformed addresses without side effects',async()=>{
  const count=async()=> (await pool.query(`SELECT (SELECT COUNT(*)::int FROM "user") AS users,
    (SELECT COUNT(*)::int FROM app_pending_registration) AS pending,
    (SELECT COUNT(*)::int FROM app_notification_outbox) AS mail,
    (SELECT COUNT(*)::int FROM app_password_reset) AS resets`)).rows[0];
  const before=await count();
  for(const email of ['a@example.com\r\nBcc: victim@example.com','\na@example.com','a@example.com\t',
    'a\u200b@example.com','a..b@example.com','a@-host.com','Name <a@example.com>','a@example.com,b@example.com']) {
    const guarded=createApp(pool,config), input=person(email);
    for(const [path,body] of [
      ['/api/auth/register',input],
      ['/api/auth/login',{identifier:email,password:input.password}],
      ['/api/auth/confirmation',input],
      ['/api/auth/confirmation',{...input,email:'valid@example.com',newEmail:email}],
      ['/api/auth/password-reset',{email}],
    ] as const) {
      const response=await request(guarded).post(path).send(body);
      assert.equal(response.status,400,`${path}: ${JSON.stringify(email)}`);
      assert.equal(response.body.error.code,'INVALID_INPUT');
    }
  }
  assert.deepEqual(await count(),before);
});

// Applying the real upgrade must preserve existing records while removing their active-member status.
test('migration quarantines a legacy unconfirmed account and preserves its confirmation link',async()=>{
  const name='arbor_legacy_registration_'+randomBytes(6).toString('hex')+'_mvc_test';
  await owner.query(`CREATE DATABASE "${name}"`);const legacy=new Pool({database:name});
  try {
    await initializeDemo(legacy);
    await legacy.query(`ALTER TABLE app_notification_outbox DROP CONSTRAINT app_notification_recipient;
      ALTER TABLE app_notification_outbox DROP COLUMN registration_id;
      ALTER TABLE app_notification_outbox ALTER COLUMN userid SET NOT NULL;
      DROP TABLE app_pending_registration;
      DELETE FROM app_migration WHERE name='030_pending_registration.sql'`);
    const { UserModel }=await import('../../src/models/UserModel.js');
    const { hashPassword }=await import('../../src/passwords.js');
    const { issueEmailConfirmation }=await import('../../src/confirmation/emailConfirmation.js');
    const { migrate }=await import('../../src/scripts/migrate.js');
    const { StaffModel }=await import('../../src/models/StaffModel.js');
    const input=person('legacy-pending@example.invalid');
    const id=await new UserModel(legacy).create({...input,password:await hashPassword(input.password)});
    await legacy.query('UPDATE "user" SET email_confirmed=false WHERE userid=$1',[id]);
    await issueEmailConfirmation(legacy,id,'http://localhost:8080');
    await migrate(legacy);
    assert.equal((await legacy.query('SELECT status FROM "user" WHERE userid=$1',[id])).rows[0].status,'pending');
    assert.equal((await new StaffModel(legacy).users('legacy-pending',0)).length,0);
    const token=await confirmationToken(legacy,input.email);
    const oldApp=createApp(legacy,config);
    assert.equal((await request(oldApp).post('/api/auth/login').send(input)).body.error.code,'EMAIL_CONFIRMATION_REQUIRED');
    const confirmed=await request(oldApp).post('/api/auth/confirm').send({token});
    assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(confirmed.body.data.user.id,id);
    assert.equal((await legacy.query('SELECT status FROM "user" WHERE userid=$1',[id])).rows[0].status,'active');
  } finally {await legacy.end();await owner.query(`DROP DATABASE "${name}"`);}
});
