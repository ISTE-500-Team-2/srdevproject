import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';

const database='arbor_account_mode_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'};
const app=createApp(pool,config);
type Session={accessToken:string;csrfToken:string;user:{id:number}};
let created=false,admin:Session,member:Session,staff:Session;

const as=(who:Session)=>({
  get:(path:string)=>request(app).get('/api'+path).set('Authorization','Bearer '+who.accessToken),
  post:(path:string,body:object={})=>request(app).post('/api'+path).set('Authorization','Bearer '+who.accessToken).set('X-CSRF-Token',who.csrfToken).send(body),
  patch:(path:string,body:object={})=>request(app).patch('/api'+path).set('Authorization','Bearer '+who.accessToken).set('X-CSRF-Token',who.csrfToken).send(body),
});
async function register(name:string):Promise<Session>{
  const email=`${name}@example.invalid`;
  const input={firstName:name,lastName:'Tester',username:name,email,phone:'1112223333',dob:'1990-01-01',password:'GoodPassword123!'};
  assert.equal((await request(app).post('/api/auth/register').send(input)).status,202);
  return (await request(app).post('/api/auth/confirm').send({token:await confirmationToken(pool,email)})).body.data;
}
const audits=async(action:string)=>(await pool.query(
  'SELECT actor_id AS "actorId",subject_id AS "subjectId" FROM app_staff_audit WHERE action=$1 ORDER BY id',[action])).rows;

before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  admin=(await request(app).post('/api/auth/demo').send({role:'admin'})).body.data;
  member=(await request(app).post('/api/auth/demo').send({role:'member'})).body.data;
  const staffAccount=await register('staffer');
  await pool.query(`INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() FROM role WHERE role='staff'`,[staffAccount.user.id]);
  staff=(await request(app).post('/api/auth/login').send({email:'staffer@example.invalid',password:'GoodPassword123!'})).body.data;
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

test('an admin opens a member account: member requests act as the member, workspace requests as the admin',async()=>{
  const opened=await as(admin).post('/admin/account-mode',{userId:member.user.id});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.equal(opened.body.data.user.id,member.user.id);
  assert.equal(opened.body.data.actingAs.actor.id,admin.user.id);

  const session=await as(admin).get('/auth/session');
  assert.equal(session.body.data.user.id,member.user.id);
  assert.equal(session.body.data.actingAs.actor.id,admin.user.id);
  assert.equal((await as(admin).get('/me/profile')).body.data.user.id,member.user.id);
  // Staff tools keep working as the admin while the account is open,
  // including the member search used across workspace forms.
  assert.equal((await as(admin).get('/admin/users?search=')).status,200);
  assert.equal((await as(admin).get('/training/members?search=jo')).status,200);
  assert.deepEqual(await audits('account_mode.opened'),[{actorId:admin.user.id,subjectId:member.user.id}]);
});

test('changes made in an open account are logged under the staff member',async()=>{
  // The member signs their own waivers so check-in is allowed.
  const waivers=(await as(member).get('/me/waivers')).body.data as {id:number;signed?:boolean}[];
  for(const waiver of waivers.filter(w=>!w.signed))
    assert.equal((await as(member).post(`/me/waivers/${waiver.id}/sign`,{accepted:true})).status,200);
  // Check-in needs a current booking: give the member one in the first room.
  const room=(await pool.query('SELECT roomid FROM room ORDER BY roomid LIMIT 1')).rows[0].roomid;
  await pool.query("INSERT INTO reservation(userid,roomid,location,starttime,endtime,status) VALUES($1,$2,'Account mode room',(now()-interval '1 minute') AT TIME ZONE 'UTC',(now()+interval '30 minutes') AT TIME ZONE 'UTC','confirmed')",[member.user.id,room]);
  const direct=await as(member).post('/me/check-ins',{roomId:room});
  assert.ok(direct.status<300,JSON.stringify(direct.body));
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  const onBehalf=await as(admin).post('/me/check-ins',{roomId:room});
  assert.ok(onBehalf.status<300,JSON.stringify(onBehalf.body));
  const rows=await audits('check_in.created');
  assert.deepEqual(rows.at(-2),{actorId:member.user.id,subjectId:member.user.id});
  assert.deepEqual(rows.at(-1),{actorId:admin.user.id,subjectId:member.user.id});
  // The automatic database row for the new check-in names the admin too.
  const inserted=await pool.query(`SELECT actor_id AS "actorId" FROM app_staff_audit WHERE action='check_in.insert' ORDER BY id DESC LIMIT 1`);
  assert.equal(inserted.rows[0].actorId,admin.user.id);
});

test('signatures and personal settings stay with the member',async()=>{
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  const sign=await as(admin).post('/me/waivers/1/sign',{});
  assert.equal(sign.status,403);assert.equal(sign.body.error.code,'NOT_IN_ACCOUNT_MODE');
  const profile=await as(admin).patch('/me/profile',{firstName:'Changed'});
  assert.equal(profile.status,403);assert.equal(profile.body.error.code,'NOT_IN_ACCOUNT_MODE');
  const notifications=await as(admin).patch('/me/notifications',{});
  assert.equal(notifications.status,403);
});

test('path spelling can not route around account-mode limits',async()=>{
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  // Express matches these spellings to the same routes.
  for(const path of ['/ME/WAIVERS/1/SIGN','/me/waivers/1/sign/','/Me/Waivers/1/Sign/'])
    assert.equal((await as(admin).post(path,{accepted:true})).status,403,path);
  for(const path of ['/ME/PROFILE','/me/profile/','/me/NOTIFICATIONS'])
    assert.equal((await as(admin).patch(path,{firstName:'Changed'})).status,403,path);
  assert.equal((await pool.query('SELECT firstname FROM "user" WHERE userid=$1',[member.user.id])).rows[0].firstname!=='Changed',true);
});

test('payment details and unlisted changes stay with the member',async()=>{
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  const portal=await as(admin).post('/me/billing/1/portal',{});
  assert.equal(portal.status,403);assert.equal(portal.body.error.code,'NOT_IN_ACCOUNT_MODE');
  const portalShout=await as(admin).post('/ME/BILLING/1/PORTAL/',{});
  assert.equal(portalShout.status,403);
  // Writes that aren't a listed member action are refused before any route runs.
  const unlisted=await as(admin).post('/me/billing/offers',{});
  assert.equal(unlisted.status,403);assert.equal(unlisted.body.error.code,'NOT_IN_ACCOUNT_MODE');
  // Reads still work.
  assert.equal((await as(admin).get('/me/overview')).status,200);
});

test('signed waiver copies stay admin-only even inside an open account',async()=>{
  assert.equal((await as(staff).post('/admin/account-mode',{userId:member.user.id})).status,200);
  const copies=await as(staff).get('/me/signed-waivers');
  assert.equal(copies.status,403);assert.equal(copies.body.error.code,'ADMIN_REQUIRED');
  assert.equal((await as(staff).get('/ME/SIGNED-WAIVERS/')).status,403);
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  assert.notEqual((await as(admin).get('/me/signed-waivers')).status,403);
  await as(staff).post('/admin/account-mode/end');
});

test('only plain member accounts can be opened, and only by staff',async()=>{
  const intoAdmin=await as(staff).post('/admin/account-mode',{userId:admin.user.id});
  assert.equal(intoAdmin.status,403);assert.equal(intoAdmin.body.error.code,'ACCOUNT_MODE_REFUSED');
  const intoStaff=await as(admin).post('/admin/account-mode',{userId:staff.user.id});
  assert.equal(intoStaff.status,403);
  const byMember=await as(member).post('/admin/account-mode',{userId:admin.user.id});
  assert.equal(byMember.status,403);assert.equal(byMember.body.error.code,'STAFF_REQUIRED');
  assert.equal((await as(admin).post('/admin/account-mode',{userId:999999})).status,404);
  assert.equal((await as(admin).post('/admin/account-mode',{userId:'x'})).status,400);
  const ownAccount=await as(admin).post('/admin/account-mode',{userId:admin.user.id});
  assert.equal(ownAccount.status,200);
  // Your own account carries no restrictions.
  assert.notEqual((await as(admin).patch('/me/notifications',{})).body.error?.code,'NOT_IN_ACCOUNT_MODE');
});

test('closing the account returns to the staff identity and is logged',async()=>{
  await as(admin).post('/admin/account-mode',{userId:member.user.id});
  const ended=await as(admin).post('/admin/account-mode/end');
  assert.equal(ended.status,200);
  assert.equal(ended.body.data.user.id,admin.user.id);
  assert.equal(ended.body.data.actingAs,null);
  const session=await as(admin).get('/auth/session');
  assert.equal(session.body.data.user.id,admin.user.id);
  assert.equal(session.body.data.actingAs,null);
  const closed=await audits('account_mode.closed');
  assert.deepEqual(closed.at(-1),{actorId:admin.user.id,subjectId:member.user.id});
});

test('an account that becomes restricted closes itself on the next request',async()=>{
  const target=await register('restricted');
  await as(admin).post('/admin/account-mode',{userId:target.user.id});
  assert.equal((await as(admin).get('/auth/session')).body.data.user.id,target.user.id);
  await pool.query(`UPDATE "user" SET accessstatus='suspended' WHERE userid=$1`,[target.user.id]);
  const session=await as(admin).get('/auth/session');
  assert.equal(session.body.data.user.id,admin.user.id);
  assert.equal(session.body.data.actingAs,null);
  const stored=await pool.query('SELECT acting_as_userid FROM app_refresh_family f JOIN app_session s ON s.family_id=f.id WHERE s.userid=$1',[admin.user.id]);
  assert.ok(stored.rows.every(row=>row.acting_as_userid===null));
});
