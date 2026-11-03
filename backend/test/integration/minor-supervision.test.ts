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
import {hashPassword} from '../../src/passwords.js';
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
async function account(email:string,dob:string){
 const password='GoodPassword123!';
 const id=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
  VALUES('Link',$1,$2,$3,'1112223333',$4,'active',true) RETURNING userid`,[email.split('@')[0],email,await hashPassword(password),dob])).rows[0].userid;
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[id]);
 const login=await request(server).post('/api/auth/login').send({email,password});assert.equal(login.status,200,JSON.stringify(login.body));
 return login.body.data;
}
const get=(who:any,path:string)=>request(server).get('/api'+path).set('Authorization','Bearer '+who.accessToken);
test('adults request a link, the minor confirms it, and either side can undo it without staff',async()=>{
 const parent=await account('parent@example.invalid','1985-05-05'),kid=await account('kid@example.invalid','2012-03-04'),other=await account('other@example.invalid','1980-01-01');
 const ask=(who:any,body:any={email:'KID@Example.invalid',dob:'2012-03-04'},csrf=true)=>post(who,'/me/minors/requests',body,csrf);
 const noMatch='No under-18 account matches that email and date of birth.';
 assert.equal((await ask(parent,undefined,false)).status,403,'CSRF required');
 for(const who of [kid,minor]){const r=await ask(who);assert.equal(r.status,403);assert.equal(r.body.error.code,'ADULT_REQUIRED');}
 for(const body of [{email:'kid@example.invalid',dob:'2012-03-05'},{email:'nobody@example.invalid',dob:'2012-03-04'},{email:'other@example.invalid',dob:'1980-01-01'}]){
  const r=await ask(parent,body);assert.equal(r.status,404);assert.equal(r.body.error.code,'NOT_FOUND');assert.equal(r.body.error.message,noMatch);
 }
 const created=await ask(parent);assert.equal(created.status,201,JSON.stringify(created.body));
 const id=created.body.data.id;assert.equal(created.body.data.minorName,'Link');assert.ok(created.body.data.createdAt);
 assert.equal((await ask(parent)).body.error.code,'REQUEST_PENDING');
 assert.deepEqual((await get(parent,'/me/minors')).body.data.requests.map((r:any)=>[r.id,r.minorName]),[[id,'Link']]);
 assert.deepEqual((await get(kid,'/me/supervision')).body.data.pendingRequests.map((r:any)=>[r.id,r.adultName]),[[id,'Link parent']]);
 for(const who of [other,parent])assert.equal((await post(who,`/me/sponsor-requests/${id}/accept`)).status,404,'only the request minor can accept');
 assert.equal((await post(kid,`/me/sponsor-requests/${id}/accept`,{},false)).status,403,'CSRF required');
 const competing=await ask(other);assert.equal(competing.status,201);
 await pool.query('INSERT INTO app_facility_visit(user_id,building_id) VALUES($1,1)',[kid.user.id]);
 const busy=await post(kid,`/me/sponsor-requests/${id}/accept`);assert.equal(busy.status,409);assert.equal(busy.body.error.code,'CHECK_OUT_FIRST');
 await pool.query('UPDATE app_facility_visit SET checked_out_at=now() WHERE user_id=$1 AND checked_out_at IS NULL',[kid.user.id]);
 const accepted=await post(kid,`/me/sponsor-requests/${id}/accept`);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 assert.equal(accepted.body.data.sponsor.id,parent.user.id);assert.deepEqual(accepted.body.data.pendingRequests,[]);
 assert.deepEqual((await pool.query('SELECT id::int,status FROM app_minor_sponsor_request WHERE minor_id=$1 ORDER BY id',[kid.user.id])).rows,
  [{id,status:'accepted'},{id:competing.body.data.id,status:'cancelled'}]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_staff_audit WHERE actor_id=$1 AND subject_id=$1 AND action='minor.sponsor_linked'",[kid.user.id])).rows[0].n,1);
 assert.equal((await post(kid,`/me/sponsor-requests/${id}/accept`)).status,404,'resolved requests cannot be replayed');
 assert.equal((await ask(parent)).body.error.code,'ALREADY_LINKED');
 // Self-service never replaces an existing sponsor: neither a new request nor a stale one accepted later.
 const taken=await ask(other);assert.equal(taken.status,409);assert.equal(taken.body.error.code,'SPONSOR_EXISTS');
 const stale=(await pool.query('INSERT INTO app_minor_sponsor_request(minor_id,adult_id) VALUES($1,$2) RETURNING id::int',[kid.user.id,other.user.id])).rows[0].id;
 const swap=await post(kid,`/me/sponsor-requests/${stale}/accept`);assert.equal(swap.status,409);assert.equal(swap.body.error.code,'SPONSOR_EXISTS');
 assert.equal((await get(kid,'/me/supervision')).body.data.sponsor.id,parent.user.id);
 await pool.query("UPDATE app_minor_sponsor_request SET status='cancelled',resolved_at=now() WHERE id=$1",[stale]);
 assert.deepEqual((await get(parent,'/me/minors')).body.data,{minors:[{id:kid.user.id,name:'Link kid',visit:null}],requests:[]});
 await pool.query('INSERT INTO app_facility_visit(user_id,building_id,sponsor_id) VALUES($1,1,$2)',[kid.user.id,parent.user.id]);
 const visiting=(await get(parent,'/me/minors')).body.data.minors[0].visit;
 assert.equal(visiting.buildingName,'Collaboratory');assert.ok(visiting.checkedInAt);
 const own=(await get(kid,'/me/supervision')).body.data.visit;assert.equal(own.buildingName,'Collaboratory');assert.ok(own.checkedInAt);
 const unlinkBusy=await post(parent,`/me/minors/${kid.user.id}/unlink`);assert.equal(unlinkBusy.status,409);assert.equal(unlinkBusy.body.error.code,'CHECK_OUT_FIRST');
 await pool.query('UPDATE app_facility_visit SET checked_out_at=now() WHERE user_id=$1 AND checked_out_at IS NULL',[kid.user.id]);
 assert.equal((await post(other,`/me/minors/${kid.user.id}/unlink`)).status,404,'only the sponsor can unlink');
 assert.equal((await post(parent,`/me/minors/${kid.user.id}/unlink`,{},false)).status,403,'CSRF required');
 const unlinked=await post(parent,`/me/minors/${kid.user.id}/unlink`);assert.equal(unlinked.status,200,JSON.stringify(unlinked.body));
 assert.deepEqual(unlinked.body.data.minors,[]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_minor_sponsor WHERE minor_id=$1',[kid.user.id])).rows[0].n,0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_staff_audit WHERE actor_id=$1 AND subject_id=$2 AND action='minor.sponsor_unlinked'",[parent.user.id,kid.user.id])).rows[0].n,1);
 assert.equal((await post(parent,`/me/minors/${kid.user.id}/unlink`)).status,404);
 const again=await ask(parent);assert.equal(again.status,201);
 assert.equal((await post(other,`/me/minors/requests/${again.body.data.id}/cancel`)).status,404,'only the requesting adult can cancel');
 assert.equal((await post(parent,`/me/minors/requests/${again.body.data.id}/cancel`,{},false)).status,403,'CSRF required');
 const cancelled=await post(parent,`/me/minors/requests/${again.body.data.id}/cancel`);assert.equal(cancelled.status,200);
 assert.deepEqual(cancelled.body.data.requests,[]);
 assert.equal((await post(parent,`/me/minors/requests/${again.body.data.id}/cancel`)).status,404);
 assert.equal((await post(kid,`/me/sponsor-requests/${again.body.data.id}/accept`)).status,404,'cancelled requests cannot be accepted');
 const declinable=await ask(other);assert.equal(declinable.status,201);
 const declined=await post(kid,`/me/sponsor-requests/${declinable.body.data.id}/decline`);assert.equal(declined.status,200);
 assert.deepEqual(declined.body.data.pendingRequests,[]);assert.equal(declined.body.data.sponsor,null);
 assert.equal((await pool.query('SELECT status FROM app_minor_sponsor_request WHERE id=$1',[declinable.body.data.id])).rows[0].status,'declined');
});
test('sponsor requests limit date-of-birth guessing per target email and per adult',async()=>{
 // A fresh app instance gets fresh in-memory limiters, independent of the other tests' traffic.
 const app2=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 const server2=app2.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server2.once('listening',resolve));
 try {
  const password='GoodPassword123!';
  for (const [email,dob] of [['guesser@example.invalid','1975-02-02'],['realparent@example.invalid','1976-03-03'],['target@example.invalid','2011-06-06']]) {
   const id=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
    VALUES('Rate','Limit',$1,$2,'1112223333',$3,'active',true) RETURNING userid`,[email,await hashPassword(password),dob])).rows[0].userid;
   await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[id]);
  }
  const login=async(email:string)=>(await request(server2).post('/api/auth/login').send({email,password})).body.data;
  const who=await login('guesser@example.invalid'),real=await login('realparent@example.invalid');
  const askAs=(user:any,email:string,dob:string)=>request(server2).post('/api/me/minors/requests').set('Authorization','Bearer '+user.accessToken)
   .set('X-CSRF-Token',user.csrfToken).send({email,dob});
  const ask=(email:string,dob:string)=>askAs(who,email,dob);
  // Concurrent guesses are serialized: exactly five misses are allowed for this adult and email.
  const burst=await Promise.all([1,2,3,4,5,6,7].map(day=>ask('TARGET@example.invalid',`2011-01-0${day}`)));
  assert.deepEqual(burst.map(r=>r.status).sort(),[404,404,404,404,404,429,429]);
  const locked=await ask('target@example.invalid','2011-06-06');assert.equal(locked.status,429,'five misses lock the email for this adult even for the right date');
  // Another adult is not locked out by someone else's misses (per-email cap across adults is 15).
  assert.equal((await askAs(real,'target@example.invalid','2011-06-06')).status,201);
  assert.equal((await pool.query("SELECT count(*)::int n FROM app_minor_sponsor_attempt WHERE email_hash LIKE '%@%'")).rows[0].n,0,'emails are stored hashed');
  // Misses older than a day still count toward the 30-day per-email cap.
  await pool.query(`INSERT INTO app_minor_sponsor_attempt(adult_id,email_hash,created_at)
   SELECT $1,email_hash,now()-interval '10 days' FROM app_minor_sponsor_attempt WHERE adult_id=$1 LIMIT 1`,[who.user.id]);
  const hash=(await pool.query('SELECT email_hash FROM app_minor_sponsor_attempt WHERE adult_id=$1 LIMIT 1',[who.user.id])).rows[0].email_hash;
  await pool.query(`INSERT INTO app_minor_sponsor_attempt(adult_id,email_hash,created_at) SELECT $1,$2,now()-interval '10 days' FROM generate_series(1,9)`,[who.user.id,hash]);
  const monthly=await askAs(real,'target@example.invalid','2011-06-07');assert.equal(monthly.status,429,'15 misses in 30 days lock the email for every adult');
  for (let n=0;n<5;n++) assert.equal((await ask(`nobody${n}@example.invalid`,'2011-01-01')).status,404);
  const capped=await ask('elsewhere@example.invalid','2011-01-01');assert.equal(capped.status,429,'ten attempts per adult per day');
 } finally {await new Promise<void>(r=>{server2.close(r);server2.closeAllConnections();});}
});
