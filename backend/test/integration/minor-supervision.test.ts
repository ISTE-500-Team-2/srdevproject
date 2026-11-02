import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {confirmationToken} from '../helpers/confirmation.js';
import {waiverAcceptance} from '../helpers/waiver.js';
import {evaluateReaderAccess} from '../../src/services/ReaderEligibility.js';
import {MinorSupervision} from '../../src/minorSupervision.js';
import {transaction} from '../../src/db.js';
const database='arbor_family_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
let app:any,server:any,admin:any,adult:any,minor:any,room:number,booking:number;
const post=(who:any,path:string,body:any={},csrf=true)=>{let r=request(server).post('/api'+path).set('Authorization','Bearer '+who.accessToken);if(csrf)r=r.set('X-CSRF-Token',who.csrfToken);return r.send(body);};
async function sign(who:any){for(const w of (await request(server).get('/api/me/waivers').set('Authorization','Bearer '+who.accessToken)).body.data)
  if(!w.signed)assert.equal((await post(who,`/me/waivers/${w.id}/sign`,waiverAcceptance(w))).status,200);}
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);await initializeDemo(pool);
 app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 admin=(await request(server).post('/api/auth/demo').send({role:'admin'})).body.data;
 adult=(await request(server).post('/api/auth/demo').send({role:'member'})).body.data;
 await pool.query("UPDATE \"user\" SET dob='1990-01-01' WHERE userid=$1",[adult.user.id]);
 const input={firstName:'Young',lastName:'Member',email:'family@example.invalid',phone:'1112223333',dob:'2010-01-01',password:'GoodPassword123!'};
 assert.equal((await request(server).post('/api/auth/register').send(input)).status,202);
 minor=(await request(server).post('/api/auth/confirm').send({token:await confirmationToken(pool,input.email)})).body.data;
 await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
  VALUES($1,1,(now()-interval '1 day') AT TIME ZONE 'UTC',(now()+interval '30 days') AT TIME ZONE 'UTC','active')`,[minor.user.id]);
 await sign(adult);await sign(minor);
 room=(await pool.query("INSERT INTO room(name,location,status,capacity) VALUES('Family fixture','Fixture','available',15) RETURNING roomid")).rows[0].roomid;
});
after(async()=>{if(server)await new Promise<void>(r=>{server.close(r);server.closeAllConnections();});await pool.end();await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
const root=()=>`/admin/users/${minor.user.id}/supervision`;
test('staff/CSRF/consent and adult age are enforced without banning minor accounts',async()=>{
 const body={adultId:adult.user.id,revision:0,consent:true,reason:'Verified sponsoring adult'};
 assert.equal((await post(minor,root(),body)).status,403);
 assert.equal((await post(admin,root(),body,false)).status,403);
 assert.equal((await post(admin,root(),{...body,consent:false})).status,400);
 assert.equal((await post(admin,root(),{...body,adultId:minor.user.id})).status,400);
 const r=await post(admin,root(),body);assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.data.marker,'Under 18');assert.equal(r.body.data.sponsor.id,adult.user.id);
 assert.equal((await post(admin,root(),body)).status,409,'stale writes fail');
});
test('both visitors need their own access; adult presence gates minor bookings and is attached to them',async()=>{
 const base=Date.now();
 const body={roomId:room,startTime:new Date(base+3600000).toISOString(),endTime:new Date(base+7200000).toISOString()};
 assert.equal((await post(minor,'/reservations',body)).body.error.code,'SPONSOR_REQUIRED');
 assert.equal((await post(admin,`${root()}/check-in`,{reason:'Minor arrived'})).status,403);
 const r=await post(admin,`/admin/users/${adult.user.id}/supervision/check-in`,{reason:'Adult physically present'});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await post(admin,`${root()}/check-in`,{reason:'Arrived together'})).status,200);
 // Use exactly whole-hour duration, independent of successive clock reads.
 body.endTime=new Date(new Date(body.startTime).getTime()+3600000).toISOString();
 const booked=await post(minor,'/reservations',body);assert.equal(booked.status,201,JSON.stringify(booked.body));booking=booked.body.data.id;
 assert.equal((await pool.query('SELECT adult_id FROM app_minor_booking WHERE reservation_id=$1',[booking])).rows[0].adult_id,adult.user.id);
 assert.equal((await post(admin,root(),{adultId:adult.user.id,revision:1,consent:true,reason:'Attempt while visiting'})).status,409);
});
test('adult checkout ends linked minor visits and denies subsequent reader grants without deleting bookings',async()=>{
 await pool.query("UPDATE reservation SET starttime=(now()-interval '1 minute') AT TIME ZONE 'UTC',endtime=(now()+interval '30 minutes') AT TIME ZONE 'UTC' WHERE reservationid=$1",[booking]);
 const allowed=await transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:room},minor.user.id));
 assert.equal(allowed.allowed,true,JSON.stringify(allowed));
 const out=await post(adult,'/me/visit/check-out');assert.equal(out.status,200,JSON.stringify(out.body));
 assert.deepEqual(out.body.data.checkedOut.map((r:any)=>r.userId).sort((a:number,b:number)=>a-b),[adult.user.id,minor.user.id].sort((a,b)=>a-b));
 const denied=await transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:room},minor.user.id));
 assert.equal(denied.allowed,false);assert.equal(denied.reason,'SPONSOR_REQUIRED');
 assert.equal((await pool.query('SELECT status FROM reservation WHERE reservationid=$1',[booking])).rows[0].status,'confirmed');
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE checked_out_at IS NULL')).rows[0].n,0);
});
test('non-admin staff cannot change protected staff/admin supervision or visits',async()=>{
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='staff'",[adult.user.id]);
 try {
  const target=`/admin/users/${admin.user.id}/supervision`;
  for(const action of ['check-in','check-out']){
   const r=await post(adult,`${target}/${action}`,{reason:'Protected account attempt'});
   assert.equal(r.status,403);assert.equal(r.body.error.code,'ADMIN_REQUIRED');
  }
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='staff'",[minor.user.id]);
  const r=await post(adult,root(),{adultId:adult.user.id,revision:1,consent:true,reason:'Protected sponsor attempt'});
  assert.equal(r.status,403);assert.equal(r.body.error.code,'ADMIN_REQUIRED');
 }finally{
  await pool.query("DELETE FROM user_role WHERE userid=ANY($1::int[]) AND roleid=(SELECT roleid FROM role WHERE role='staff')",[[adult.user.id,minor.user.id]]);
 }
});
test('a class requires the sponsor in its own building and records the sponsor without granting certification',async()=>{
 const other=(await pool.query("INSERT INTO building(name) VALUES('Family second building') RETURNING buildingid")).rows[0].buildingid;
 const classroom=(await pool.query("INSERT INTO room(name,location,status,capacity,buildingid) VALUES('Family classroom','Fixture','available',15,$1) RETURNING roomid",[other])).rows[0].roomid;
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin.user.id]);
 const catalog=(await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
 const start=Date.now()+86400000;
 const created=await post(admin,'/classes',{title:'Family class',catalogId:catalog,instructorId:admin.user.id,roomId:classroom,capacity:15,startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),reason:'Building eligibility test'});
 assert.equal(created.status,201,JSON.stringify(created.body));
 assert.equal((await post(admin,`/admin/users/${adult.user.id}/supervision/check-in`,{reason:'Adult at first building'})).status,200);
 const path=`/classes/${created.body.data.id}/enroll`;
 const denied=await post(minor,path);assert.equal(denied.status,403);assert.equal(denied.body.error.code,'SPONSOR_REQUIRED');
 assert.equal((await post(admin,`/admin/users/${adult.user.id}/supervision/check-in`,{buildingId:other,reason:'Adult arrived at second building'})).status,200);
 const enrolled=await post(minor,path);assert.equal(enrolled.status,200,JSON.stringify(enrolled.body));
 assert.equal((await pool.query('SELECT sponsor_id FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2',[created.body.data.id,minor.user.id])).rows[0].sponsor_id,adult.user.id);
});
test('minor-only checkout immediately denies renewal; adult building transfer checks out supervised minors',async()=>{
 await transaction(pool,db=>new MinorSupervision(db).startVisit(adult.user.id,1));
 await transaction(pool,db=>new MinorSupervision(db).startVisit(minor.user.id,1));
 const evaluate=()=>transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:room},minor.user.id,true));
 assert.equal((await evaluate()).allowed,true);
 assert.equal((await post(minor,'/me/visit/check-out')).status,200);
 const denied=await evaluate();assert.equal(denied.allowed,false);assert.equal(denied.reason,'MINOR_CHECK_IN_REQUIRED');
 await transaction(pool,db=>new MinorSupervision(db).startVisit(minor.user.id,1));
 const other=(await pool.query("SELECT buildingid FROM building WHERE name='Family second building'")).rows[0].buildingid;
 await transaction(pool,db=>new MinorSupervision(db).startVisit(adult.user.id,other));
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[minor.user.id])).rows[0].n,0);
 assert.equal((await evaluate()).allowed,false);
});
test('concurrent adult checkout and minor check-in cannot leave an unsupervised open visit',async()=>{
 for(let attempt=0;attempt<3;attempt++){
  await transaction(pool,db=>new MinorSupervision(db).startVisit(adult.user.id,1));
  const [arriving,leaving]=await Promise.allSettled([
   transaction(pool,db=>new MinorSupervision(db).startVisit(minor.user.id,1)),
   transaction(pool,db=>new MinorSupervision(db).checkout(adult.user.id)),
  ]);
  assert.equal(leaving.status,'fulfilled');
  if(arriving.status==='rejected')assert.equal(arriving.reason.code,'SPONSOR_REQUIRED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=ANY($1::int[]) AND checked_out_at IS NULL',[[adult.user.id,minor.user.id]])).rows[0].n,0);
 }
});
test('a revoked sponsor or previous-day visit cannot authorize a minor',async()=>{
 await post(admin,`/admin/users/${adult.user.id}/supervision/check-in`,{reason:'New visit'});
 await pool.query("UPDATE app_facility_visit SET checked_in_at=now()-interval '2 days' WHERE user_id=$1 AND checked_out_at IS NULL",[adult.user.id]);
 await assert.rejects(transaction(pool,db=>new MinorSupervision(db).requireSponsor(minor.user.id)),{code:'SPONSOR_REQUIRED'});
 await pool.query('UPDATE app_facility_visit SET checked_in_at=now() WHERE user_id=$1 AND checked_out_at IS NULL',[adult.user.id]);
 await pool.query("UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1",[adult.user.id]);
 await assert.rejects(transaction(pool,db=>new MinorSupervision(db).requireSponsor(minor.user.id)),{code:'SPONSOR_REQUIRED'});
});
