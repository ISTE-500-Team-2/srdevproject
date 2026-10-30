import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { migrate } from '../../src/scripts/migrate.js';
import { hashPassword } from '../../src/passwords.js';
import { confirmationToken } from '../helpers/confirmation.js';

const database='arbor_usernames_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'};
const app=createApp(pool,config);
let created=false,member:any,admin:any,instructor:any,otherInstructor:any,classId:number;
const input={firstName:'Private',lastName:'Participant',username:'New.Member',email:'new.member@example.invalid',phone:'1112223333',dob:'1995-01-01',password:'GoodPassword123!'};
const get=(path:string,actor=member)=>request(app).get('/api'+path).set('Authorization','Bearer '+actor.accessToken);
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  admin=(await request(app).post('/api/auth/demo').send({role:'admin'})).body.data;
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

// New public accounts never acquire a username, even when an older client still sends that field.
test('public signup uses confirmed email while existing username logins remain supported',async()=>{
  assert.equal((await request(app).post('/api/auth/register').send(input)).status,202);
  assert.equal((await request(app).post('/api/auth/login').send({identifier:input.email,password:input.password})).body.error.code,'EMAIL_CONFIRMATION_REQUIRED');
  member=(await request(app).post('/api/auth/confirm').send({token:await confirmationToken(pool,input.email)})).body.data;
  assert.equal(member.user.username,null);
  assert.equal((await request(app).post('/api/auth/login').send({identifier:input.email.toUpperCase(),password:input.password})).status,200);
  assert.equal((await request(app).post('/api/auth/login').send({identifier:input.username,password:input.password})).status,401);
  await pool.query(`UPDATE "user" SET username='legacy.admin',password=$1 WHERE email='demo.admin@collaboratory.invalid'`,[await hashPassword('LegacyUsername!')]);
  assert.equal((await request(app).post('/api/auth/login').send({identifier:'LEGACY.ADMIN',password:'LegacyUsername!'})).status,200);
});

test('additive migration keeps a legacy email account, password, membership and session intact',async()=>{
  const legacyName='arbor_legacy_'+randomBytes(6).toString('hex')+'_mvc_test',legacy=new Pool({database:legacyName});
  await owner.query(`CREATE DATABASE "${legacyName}"`);
  try{
    await initializeDemo(legacy);
    const password=await hashPassword('LegacyPassword!');
    await legacy.query(`UPDATE "user" SET password=$1 WHERE email='demo.member@collaboratory.invalid'`,[password]);
    const legacyApp=createApp(legacy,config);
    const login=await request(legacyApp).post('/api/auth/login').send({email:'demo.member@collaboratory.invalid',password:'LegacyPassword!'});
    assert.equal(login.status,200);
    const before=(await legacy.query(`SELECT userid,password FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0];
    const memberships=(await legacy.query('SELECT * FROM user_membership WHERE userid=$1',[before.userid])).rows;
    // Recreate the pre-023 shape; apply the actual additive migration to it.
    await legacy.query('ALTER TABLE "user" DROP COLUMN username CASCADE');
    await legacy.query("DELETE FROM app_migration WHERE name='023_usernames.sql'");
    await migrate(legacy);await migrate(legacy);
    const after=(await legacy.query('SELECT userid,password,username FROM "user" WHERE userid=$1',[before.userid])).rows[0];
    assert.deepEqual(after,{...before,username:null});
    assert.deepEqual((await legacy.query('SELECT * FROM user_membership WHERE userid=$1',[before.userid])).rows,memberships);
    assert.equal((await request(legacyApp).get('/api/auth/session').set('Authorization','Bearer '+login.body.data.accessToken)).status,200);
    assert.equal((await request(legacyApp).post('/api/auth/login').send({email:'DEMO.MEMBER@COLLABORATORY.INVALID',password:'LegacyPassword!'})).status,200);
  }finally{await legacy.end();await owner.query(`DROP DATABASE "${legacyName}"`);}
});

test('member roster shows only first name/last initial and current seats; withdrawals disappear',async()=>{
  const ids=(await pool.query(`SELECT userid FROM "user" WHERE email IN ('demo.admin@collaboratory.invalid','demo.member@collaboratory.invalid') ORDER BY email`)).rows;
  const instructorId=ids[1].userid;
  const otherId=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,phone,password,status,email_confirmed)
    VALUES('Other','Instructor','other.instructor@example.invalid','0000000000',$1,'active',true) RETURNING userid`,[await hashPassword('OtherInstructor!')])).rows[0].userid;
  for(const id of [instructorId,otherId])await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[id]);
  instructor=(await request(app).post('/api/auth/demo').send({role:'member'})).body.data;
  assert(!instructor.user.roles.some((role:string)=>['admin','staff'].includes(role)));
  otherInstructor=(await request(app).post('/api/auth/login').send({email:'other.instructor@example.invalid',password:'OtherInstructor!'})).body.data;
  const cert=(await pool.query("INSERT INTO certifications(certid,name,validity_days) SELECT COALESCE(MAX(certid),0)+1,'Private roster safety',30 FROM certifications RETURNING certid")).rows[0].certid;
  const room=(await pool.query("SELECT roomid FROM room WHERE status='available' AND capacity>=2 LIMIT 1")).rows[0].roomid;
  const starts=new Date(Date.now()+86400000),ends=new Date(starts.getTime()+3600000);
  const c=await request(app).post('/api/classes').set('Authorization','Bearer '+admin.accessToken).set('X-CSRF-Token',admin.csrfToken).send({title:'Privacy regression class',certificationId:cert,instructorId,roomId:room,capacity:2,startsAt:starts.toISOString(),endsAt:ends.toISOString(),reason:'Isolated regression fixture'});
  assert.equal(c.status,201,JSON.stringify(c.body));classId=c.body.data.id;
  await pool.query("INSERT INTO app_training_enrollment(class_id,user_id) VALUES($1,$2)",[classId,member.user.id]);
  let r=await get(`/classes/${classId}/member-roster`);
  assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
  assert.deepEqual(r.body.data,{capacity:2,enrolled:1,seatsAvailable:1,items:[{name:'Private P.'}]});
  for(const forbidden of ['email','phone','address','userId','username','status','example.invalid','1112223333','Participant'])assert(!JSON.stringify(r.body.data).includes(forbidden),forbidden);
  assert.equal((await request(app).get(`/api/classes/${classId}/member-roster`)).status,401);
  assert.equal((await get(`/classes/${classId}/roster`)).status,403,'Private instructor endpoint stays closed to members');
  r=await get(`/classes/${classId}/roster`,instructor);assert.equal(r.status,200);assert.equal(r.body.data[0].email,input.email);
  assert.equal((await get(`/classes/${classId}/roster`,otherInstructor)).status,403,'Unassigned instructor still cannot read contacts');
  await pool.query("UPDATE app_training_enrollment SET status='cancelled' WHERE class_id=$1",[classId]);
  r=await get(`/classes/${classId}/member-roster`);assert.deepEqual(r.body.data,{capacity:2,enrolled:0,seatsAvailable:2,items:[]});
});

test('member roster excludes past/cancelled classes and malformed IDs',async()=>{
  const path=`/classes/${classId}/member-roster`;
  await pool.query("UPDATE app_training_class SET status='cancelled' WHERE id=$1",[classId]);
  assert.equal((await get(path)).status,404);
  await pool.query("UPDATE app_training_class SET status='scheduled' WHERE id=$1",[classId]);
  await pool.query("UPDATE reservation SET starttime=(NOW()-interval '2 hours') AT TIME ZONE 'UTC',endtime=(NOW()-interval '1 hour') AT TIME ZONE 'UTC' WHERE reservationid=(SELECT reservation_id FROM app_training_class WHERE id=$1)",[classId]);
  assert.equal((await get(path)).status,404);
  assert.equal((await get('/classes/not-an-id/member-roster')).status,400);
  assert.equal((await get('/classes/2147483647/member-roster')).status,404);
});

test('class routes reject overflowing INTEGER class IDs before querying',async()=>{
  for(const id of ['2147483648',String(Number.MAX_SAFE_INTEGER)]){
    for(const [suffix,actor] of [['member-roster',member],['roster',instructor]] as const){
      const response=await get(`/classes/${id}/${suffix}`,actor);
      assert.equal(response.status,400,JSON.stringify(response.body));
      assert.equal(response.body.error.code,'INVALID_INPUT');
    }
    for(const [suffix,actor] of [['enroll',member],['withdraw',member],['attendance',instructor],['cancel',admin]] as const){
      const response=await request(app).post(`/api/classes/${id}/${suffix}`)
        .set('Authorization','Bearer '+actor.accessToken).set('X-CSRF-Token',actor.csrfToken).send({});
      assert.equal(response.status,400,JSON.stringify(response.body));
      assert.equal(response.body.error.code,'INVALID_INPUT');
    }
  }
  assert.equal((await get('/classes/2147483647/roster',instructor)).status,404);
});
