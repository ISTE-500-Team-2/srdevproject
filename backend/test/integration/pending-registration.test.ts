import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';
import { runNotificationBatch } from '../../src/notifications/worker.js';
import { pruneRegistrations } from '../../src/confirmation/pendingRegistration.js';
import { transaction } from '../../src/db.js';
import { hashPassword } from '../../src/passwords.js';

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

// The previous release hashes the link as plain SHA-256 hex and stores it in token_hash.
const legacyDigest = (token: string) => createHash('sha256').update(token).digest('hex');

async function stageLegacyRegistration(input: ReturnType<typeof person>) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO app_pending_registration(email,first_name,last_name,phone,dob,password_hash,time_zone,token_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [input.email, input.firstName, input.lastName, input.phone, input.dob, await hashPassword(input.password), config.timeZone, legacyDigest(token)]);
  return token;
}

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
  const results=await Promise.all([1,2].map(()=>request(app).post('/api/auth/confirm').send({token,password:input.password})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  const member=results.find(r=>r.status===200)!.body.data;
  assert(!Object.hasOwn(member.user,'username'));
  assert.ok(member.user.roles.includes('member'));
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',[input.email])).rowCount,0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM "user" WHERE email=$1',[input.email])).rows[0].n,1);
  // Opening the link again after it worked says it may already have been used.
  const again=await request(app).post('/api/auth/confirm').send({token,password:input.password});
  assert.equal(again.body.error.code,'CONFIRMATION_INVALID');assert.match(again.body.error.message,/already used/);
});

// Previously a second sign-up was silently dropped, so whoever staged an address first chose the
// password of the account its owner later confirmed.
test('a newer sign-up replaces a pending one: earlier links stop working and the newest password wins',async()=>{
  const input=person('repeated@example.invalid');
  // A stranger stages the address first, with a password of their choosing.
  assert.equal((await request(app).post('/api/auth/register').send({...input,firstName:'Stranger',password:'StrangerPassword!'})).status,202);
  const strangers=await confirmationToken(pool,input.email);
  // The owner signs up; nothing tells them the address was already pending.
  const owners=await register(input.email);
  assert.equal(owners.status,202);
  const current=await confirmationToken(pool,input.email);
  assert.notEqual(current,strangers);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM app_notification_outbox WHERE status='pending' AND registration_id=(SELECT id FROM app_pending_registration WHERE email=$1)`,[input.email])).rows[0].n,1);
  assert.equal((await request(app).post('/api/auth/confirm').send({token:strangers,password:'StrangerPassword!'})).status,400);
  const confirmed=await request(app).post('/api/auth/confirm').send({token:current,password:input.password});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.data.user.firstName,'Pending');
  assert.equal((await request(app).post('/api/auth/login').send({email:input.email,password:'StrangerPassword!'})).status,401);
  assert.equal((await request(app).post('/api/auth/login').send({email:input.email,password:input.password})).status,200);
});

test('rollback cannot consume a replacement link or mint a legacy link for the replaced sign-up', async () => {
  const input = person('rollback-registration@example.invalid');
  const original = await stageLegacyRegistration(input);
  const password = 'ReplacementPassword!';
  assert.equal((await request(app).post('/api/auth/register').send({ ...input, password })).status, 202);
  const replacement = await confirmationToken(pool, input.email);
  assert.notEqual(replacement, original);

  // Run both lookup statements from c95a2b5's consumeRegistration, including the row lock.
  await transaction(pool, async db => {
    for (const token of [original, replacement]) {
      const hash = legacyDigest(token);
      const found = await db.query('SELECT email FROM app_pending_registration WHERE token_hash=$1', [hash]);
      assert.equal(found.rowCount, 0, 'old confirmation must not find either link');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,30))', [input.email]);
      const locked = await db.query('SELECT * FROM app_pending_registration WHERE token_hash=$1 FOR UPDATE', [hash]);
      assert.equal(locked.rowCount, 0);
    }
  });

  // The old resend path authenticates with the pending password, then attempts to write
  // a token its one-click confirmation could consume. The database must reject that write.
  const { id } = (await pool.query('SELECT id FROM app_pending_registration WHERE email=$1', [input.email])).rows[0];
  await assert.rejects(pool.query('UPDATE app_pending_registration SET token_hash=$2,expires_at=$3,sent_at=NOW() WHERE id=$1',
    [id, legacyDigest(randomBytes(32).toString('base64url')), new Date(Date.now() + 86_400_000)]),
  { code: '23514', constraint: 'app_pending_registration_password_confirmation' });

  const confirm = (token: string, password: string) => request(app).post('/api/auth/confirm').send({ token, password });
  assert.equal((await confirm(original, password)).status, 400);
  assert.equal((await confirm(replacement, input.password)).status, 401);
  assert.equal((await confirm(replacement, password)).status, 200);
});

test('password-aware confirmation still accepts outstanding links issued by the previous release', async () => {
  const input = person('legacy-staged-link@example.invalid');
  const token = await stageLegacyRegistration(input);
  const confirm = (password: string) => request(app).post('/api/auth/confirm').send({ token, password });
  assert.equal((await confirm('WrongPassword!')).status, 401);
  assert.equal((await confirm(input.password)).status, 200);
});

// The other order: a stranger signs the address up after its owner, and their link is mailed to the
// owner's inbox. If the link alone created the account, the owner clicking the newest email would
// give the stranger an account in the owner's name.
test('confirming takes the sign-up password, so a link from a stranger\'s later sign-up never creates the account',async()=>{
  const input=person('owner-first@example.invalid');
  const accounts=async()=>(await pool.query('SELECT COUNT(*)::int AS n FROM "user" WHERE email=$1',[input.email])).rows[0].n;
  assert.equal((await register(input.email)).status,202);
  assert.equal((await request(app).post('/api/auth/register').send({...input,firstName:'Stranger',password:'StrangerPassword!'})).status,202);
  const strangers=await confirmationToken(pool,input.email);
  // The owner opens the newest email and enters their own password: nothing is created.
  const refused=await request(app).post('/api/auth/confirm').send({token:strangers,password:input.password});
  assert.equal(refused.status,401);assert.equal(refused.body.error.code,'CONFIRMATION_PASSWORD_MISMATCH');
  assert.match(refused.body.error.message,/sign up again/);
  // The link alone does nothing either.
  const bare=await request(app).post('/api/auth/confirm').send({token:strangers});
  assert.equal(bare.status,400);assert.equal(bare.body.error.field,'password');
  assert.equal(await accounts(),0);
  // Signing up again takes the request back, and only the owner's password confirms it.
  assert.equal((await register(input.email)).status,202);
  const owners=await confirmationToken(pool,input.email);
  assert.equal((await request(app).post('/api/auth/confirm').send({token:owners,password:'StrangerPassword!'})).status,401);
  const confirmed=await request(app).post('/api/auth/confirm').send({token:owners,password:input.password});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.data.user.firstName,'Pending');
  assert.equal(await accounts(),1);
  assert.equal((await request(app).post('/api/auth/login').send({email:input.email,password:'StrangerPassword!'})).status,401);
});

test('authenticated resends rotate links, at most once a minute',async()=>{
  const input=person('resent@example.invalid');await register(input.email);
  const old=await confirmationToken(pool,input.email);
  assert.equal((await request(app).post('/api/auth/confirmation').send({...input,newEmail:'corrected@example.invalid'})).status,429);
  await pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=$1",[input.email]);
  assert.equal((await request(app).post('/api/auth/confirmation').send({...input,newEmail:'corrected@example.invalid'})).status,202);
  assert.equal((await request(app).post('/api/auth/confirm').send({token:old,password:input.password})).status,400);
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1',['corrected@example.invalid'])).rowCount,0);
  assert.notEqual(await confirmationToken(pool,'corrected@example.invalid'),old);
});

test('signing up with an address that has an account looks like any sign-up, and its owner is told',async()=>{
  const fresh=await request(createApp(pool,config)).post('/api/auth/register').send(person('brand-new@example.invalid'));
  const taken=await request(createApp(pool,config)).post('/api/auth/register').send({...person(' Demo.Member@Collaboratory.invalid '),password:'AnotherPassword!'});
  assert.equal(taken.status,fresh.status);
  assert.deepEqual(Object.keys(taken.body.data).sort(),Object.keys(fresh.body.data).sort());
  assert.equal(taken.body.data.email,'demo.member@collaboratory.invalid');
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',['demo.member@collaboratory.invalid'])).rowCount,0);
  const notices=async()=>(await pool.query(`SELECT o.kind,o.status FROM app_notification_outbox o JOIN "user" u USING(userid)
    WHERE u.email='demo.member@collaboratory.invalid' AND o.kind='account_exists'`)).rows;
  assert.deepEqual(await notices(),[{kind:'account_exists',status:'pending'}]);
  // A notice just across a clock-hour boundary is still recent. Set the row's age
  // directly so the assertion is independent of when the suite runs.
  const ageNotice = (age: string) => pool.query(`UPDATE app_notification_outbox
    SET created_at=now()-$1::interval WHERE kind='account_exists' AND userid=(
      SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid')`, [age]);
  const tryAgain = () => request(createApp(pool,config)).post('/api/auth/register').send(person('demo.member@collaboratory.invalid'));
  await ageNotice('59 minutes');
  assert.equal((await tryAgain()).status,202);
  assert.equal((await notices()).length,1);
  await ageNotice('61 minutes');
  const attempts = await Promise.all([tryAgain(),tryAgain()]);
  assert.deepEqual(attempts.map(response=>response.status),[202,202]);
  assert.equal((await notices()).length,2);
  // The account itself is untouched.
  assert.equal((await request(app).post('/api/auth/login').send({email:'demo.member@collaboratory.invalid',password:'AnotherPassword!'})).status,401);
});

// Older accounts that never confirmed their email are held as 'pending'. Their owners are the likeliest
// to sign up again, and sign-up now answers 'check your inbox', so the notice must actually reach them.
test('signing up with an older unconfirmed account\'s address emails that account the notice',async()=>{
  const email='legacy-unconfirmed@example.invalid';
  const { UserModel }=await import('../../src/models/UserModel.js');
  const { hashPassword }=await import('../../src/passwords.js');
  const id=await new UserModel(pool).create({...person(email),password:await hashPassword('LegacyPassword!')});
  await pool.query(`UPDATE "user" SET email_confirmed=false,status='pending' WHERE userid=$1`,[id]);
  assert.equal((await request(createApp(pool,config)).post('/api/auth/register').send(person(email))).status,202);
  assert.deepEqual((await pool.query(`SELECT status FROM app_notification_outbox WHERE userid=$1 AND kind='account_exists'`,[id])).rows,[{status:'pending'}]);
  const sent:string[]=[];
  await runNotificationBatch(pool,async job=>{if(job.email===email)sent.push(job.kind);return{messageId:'legacy-'+randomBytes(6).toString('hex')};},{batchSize:100});
  assert.deepEqual(sent,['account_exists']);
});

// Sign-up answers alike for every address, so without a cap anyone could make it email one inbox endlessly.
test('repeated sign-ups email one address at most three times an hour; the newest can still ask for a link',async()=>{
  const signups=createApp(pool,config), email='flooded@example.invalid';
  const links:string[]=[];
  const deliver=()=>runNotificationBatch(pool,async job=>{
    if(job.email===email)links.push(new URL(String(job.payload.confirmationUrl)).hash.slice(1));
    return{messageId:'flood-'+randomBytes(6).toString('hex')};
  });
  for(let i=0;i<6;i++){
    assert.equal((await request(signups).post('/api/auth/register').send({...person(email),password:`FloodPassword${i}!`})).status,202);
    await deliver();
  }
  assert.equal(links.length,3);
  // Past the cap a sign-up still takes the request over: no link already sent works any more.
  for(const token of links)assert.equal((await request(app).post('/api/auth/confirm').send({token,password:'FloodPassword5!'})).status,400);
  // The newest person to sign up asks for a link with their password, as the confirm page offers.
  await pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=$1",[email]);
  assert.equal((await request(signups).post('/api/auth/confirmation').send({email,password:'FloodPassword5!'})).status,202);
  await deliver();
  assert.equal(links.length,4);
  assert.equal((await request(app).post('/api/auth/confirm').send({token:links.at(-1),password:'FloodPassword5!'})).status,200);
  assert.equal((await request(app).post('/api/auth/login').send({email,password:'FloodPassword5!'})).status,200);
});

// The answer never says whether a correction moved anything, so the page repeats the same pair.
test('a corrected resend retried after a mistyped password, or after it already moved, still reaches the sign-up',async()=>{
  const flow=createApp(pool,config);
  const input=person('retry-typo@example.invalid'),corrected='retry-right@example.invalid';
  const resend=(password:string)=>request(flow).post('/api/auth/confirmation').send({...input,password,newEmail:corrected});
  const wait=()=>pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=ANY($1::text[])",[[input.email,corrected]]);
  await register(input.email);await wait();
  const first=await confirmationToken(pool,input.email);
  assert.equal((await resend('WrongPassword!')).status,202);
  assert.equal(await confirmationToken(pool,input.email),first,'a wrong password moves nothing');
  assert.equal((await resend(input.password)).status,202);
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',[input.email])).rowCount,0);
  const moved=await confirmationToken(pool,corrected);
  await wait();
  assert.equal((await resend(input.password)).status,202);
  const again=await confirmationToken(pool,corrected);
  assert.notEqual(again,moved,'the repeat finds the sign-up under the corrected address and sends a fresh link');
  const confirmed=await request(flow).post('/api/auth/confirm').send({token:again,password:input.password});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.data.user.email,corrected);
});

test('the email worker sends staged confirmation without activating a member and expired requests are purged',async()=>{
  await register('worker@example.invalid');
  // Read the link the way the email would deliver it: once sent, the outbox no longer keeps it.
  const token=await confirmationToken(pool,'worker@example.invalid');
  const sent:string[]=[];
  const result=await runNotificationBatch(pool,async job=>{sent.push(job.email);return{messageId:'test-'+sent.length};});
  assert.ok(result.accepted>=1);assert.ok(sent.includes('worker@example.invalid'));
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE email=$1',['worker@example.invalid'])).rowCount,0);
  assert.equal((await pool.query(`SELECT 1 FROM app_notification_outbox WHERE status='accepted' AND payload ? 'confirmationUrl'`)).rowCount,0);
  await pool.query("UPDATE app_pending_registration SET expires_at=NOW()-INTERVAL '1 second' WHERE email=$1",['worker@example.invalid']);
  assert.equal((await request(app).post('/api/auth/confirm').send({token,password:'ValidPassword!'})).status,400);
  await pruneRegistrations(pool);
  assert.equal((await pool.query('SELECT 1 FROM app_pending_registration WHERE email=$1',['worker@example.invalid'])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM app_notification_outbox WHERE payload->>\'confirmationUrl\' LIKE $1',['%'+token])).rowCount,0);
});

test('public signup has an independent thirty-attempt IP limit',async()=>{
  const limited=createApp(pool,config);
  const from=(address:string)=>request(limited).post('/api/auth/register').set('X-Forwarded-For',address);
  for(let i=0;i<30;i++)assert.equal((await from('203.0.113.40').send({})).status,400);
  const response=await from('203.0.113.40').send(person('limited@example.invalid'));
  assert.equal(response.status,429);assert.ok(response.headers['retry-after']);
  // An address the app cannot see (a hiding proxy) gets no shared budget, and no per-email one
  // either: nobody can block a chosen person's sign-up by trying their address over and over.
  for(let i=0;i<40;i++)assert.equal((await from('172.16.1.254').send({email:'again@example.invalid'})).status,400);
  assert.equal((await from('198.51.100.40').send(person('again@example.invalid'))).status,202);
  assert.equal((await from('172.16.1.254').send({})).status,400);
});

// Real API/database flows must agree on address identity without removing meaningful dots or plus tags.
test('signup, duplicates, correction, delivery, login and password recovery share email identity rules',async()=>{
  const flow=createApp(pool,config);
  const initial='first.last+studio@example.com', corrected='first.last+workshop@example.com';
  const input=person(' First.Last+Studio@Example.COM ');
  assert.equal((await request(flow).post('/api/auth/register').send(input)).status,202);
  const first=await confirmationToken(pool,initial);
  // The same address in other letter case is the same pending request, sent a fresh link.
  assert.equal((await request(flow).post('/api/auth/register').send({...input,email:initial.toUpperCase()})).status,202);
  const old=await confirmationToken(pool,initial);
  assert.notEqual(old,first);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_pending_registration WHERE lower(email)=$1',[initial])).rows[0].n,1);
  await pool.query("UPDATE app_pending_registration SET sent_at=NOW()-INTERVAL '61 seconds' WHERE email=$1",[initial]);
  assert.equal((await request(flow).post('/api/auth/confirmation').send({...input,newEmail:' First.Last+Workshop@Example.COM '})).status,202);
  assert.equal((await request(flow).post('/api/auth/confirm').send({token:old,password:input.password})).status,400);
  const correctedToken=await confirmationToken(pool,corrected);
  const recipients:string[]=[];
  await runNotificationBatch(pool,async job=>{recipients.push(job.email);return{messageId:'identity-'+randomBytes(6).toString('hex')};});
  assert.ok(recipients.includes(corrected));
  const confirmed=await request(flow).post('/api/auth/confirm').send({token:correctedToken,password:input.password});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.data.user.email,corrected);
  const id=confirmed.body.data.user.id;
  const login=await request(flow).post('/api/auth/login').send({email:' First.Last+Workshop@Example.COM ',password:input.password});
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
      ['/api/auth/login',{email,password:input.password}],
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
      DELETE FROM app_migration WHERE name IN ('030_pending_registration.sql','055_pending_registration_password_confirmation.sql')`);
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
    // An older account's link takes its password too, and a wrong one leaves the link working.
    const wrong=await request(oldApp).post('/api/auth/confirm').send({token,password:'WrongPassword!'});
    assert.equal(wrong.status,401);assert.equal(wrong.body.error.code,'CONFIRMATION_PASSWORD_MISMATCH');
    // Signing up again only emails this account's owner, so the message points to a password reset.
    assert.match(wrong.body.error.message,/Forgot password/);assert.doesNotMatch(wrong.body.error.message,/sign up again/);
    const confirmed=await request(oldApp).post('/api/auth/confirm').send({token,password:input.password});
    assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(confirmed.body.data.user.id,id);
    assert.equal((await legacy.query('SELECT status FROM "user" WHERE userid=$1',[id])).rows[0].status,'active');
  } finally {await legacy.end();await owner.query(`DROP DATABASE "${name}"`);}
});
