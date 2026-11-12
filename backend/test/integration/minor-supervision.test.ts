import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
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
import {StudioService} from '../../src/studios/service.js';
import {MemberModel} from '../../src/models/MemberModel.js';
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
 // A supervising adult is not operating equipment. Their unsigned equipment
 // agreement must not block either visitor's facility arrival or the minor's booking.
 await pool.query(`DELETE FROM user_waiver WHERE userid=$1 AND waiverid IN
  (SELECT waiverid FROM waiver WHERE policy_scope='equipment')`,[adult.user.id]);
 const base=Date.now();
 const body={roomId:room,startTime:new Date(base+3600000).toISOString(),endTime:new Date(base+7200000).toISOString()};
 assert.equal((await post(minor,'/reservations',body)).body.error.code,'SPONSOR_REQUIRED');
 assert.equal((await post(admin,`${root()}/check-in`,{reason:'Minor arrived'})).status,403);
 // A desk check-in needs no note; the change log still records one.
 const r=await post(admin,`/admin/users/${adult.user.id}/supervision/check-in`,{});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await pool.query(`SELECT reason FROM app_staff_audit WHERE subject_id=$1 AND action='visit.check-in' ORDER BY id DESC LIMIT 1`,[adult.user.id])).rows[0].reason,'Checked in at the front desk');
 assert.equal((await post(admin,`${root()}/check-in`,{reason:'Arrived together'})).status,200);
 // Use exactly whole-hour duration, independent of successive clock reads.
 body.endTime=new Date(new Date(body.startTime).getTime()+3600000).toISOString();
 const booked=await post(minor,'/reservations',body);assert.equal(booked.status,201,JSON.stringify(booked.body));booking=booked.body.data.id;
 assert.equal((await pool.query('SELECT adult_id FROM app_minor_booking WHERE reservation_id=$1',[booking])).rows[0].adult_id,adult.user.id);
 assert.equal((await post(admin,root(),{adultId:adult.user.id,revision:1,consent:true,reason:'Attempt while visiting'})).status,409);
});
test('a supervised minor can enter the building before a reservation without gaining room access',async()=>{
 const building=()=>transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'building',resourceId:1},minor.user.id));
 const early=await building();
 assert.equal(early.allowed,true,JSON.stringify(early));assert.equal(early.reservationId,null);
 const roomAccess=await transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:room},minor.user.id));
 assert.equal(roomAccess.allowed,false);assert.equal(roomAccess.reason,'RESERVATION_REQUIRED');
 await post(adult,'/me/visit/check-out');
 const denied=await building();assert.equal(denied.allowed,false);assert.equal(denied.reason,'SPONSOR_REQUIRED');
 await transaction(pool,async db=>{
  await new MinorSupervision(db).startVisit(adult.user.id,1);
  await new MinorSupervision(db).startVisit(minor.user.id,1);
 });
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
test('advance class enrollment records the linked sponsor without requiring a current visit',async()=>{
 const other=(await pool.query("INSERT INTO building(name) VALUES('Family second building') RETURNING buildingid")).rows[0].buildingid;
 const classroom=(await pool.query("INSERT INTO room(name,location,status,capacity,buildingid) VALUES('Family classroom','Fixture','available',15,$1) RETURNING roomid",[other])).rows[0].roomid;
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin.user.id]);
 const catalog=(await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
 const start=Date.now()+86400000;
 const created=await post(admin,'/classes',{title:'Family class',catalogId:catalog,instructorId:admin.user.id,roomId:classroom,capacity:15,startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),reason:'Building eligibility test'});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const path=`/classes/${created.body.data.id}/enroll`;
 await post(adult,'/me/visit/check-out');
 assert.equal((await pool.query('SELECT 1 FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[adult.user.id])).rowCount,0,'the sponsor is away at signup');
 await pool.query("UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1",[adult.user.id]);
 try {
  assert.equal((await get(minor,'/me/supervision')).body.data.sponsorEligible,false,'the class page can warn before signup');
  const denied=await post(minor,path);assert.equal(denied.status,403);assert.equal(denied.body.error.code,'SPONSOR_REQUIRED');
 } finally {
  await pool.query("UPDATE \"user\" SET accessstatus='active' WHERE userid=$1",[adult.user.id]);
 }
 assert.equal((await get(minor,'/me/supervision')).body.data.sponsorEligible,true);
 const enrolled=await post(minor,path);assert.equal(enrolled.status,200,JSON.stringify(enrolled.body));
 assert.equal((await pool.query('SELECT sponsor_id FROM app_training_enrollment WHERE class_id=$1 AND user_id=$2',[created.body.data.id,minor.user.id])).rows[0].sponsor_id,adult.user.id);
});
test('staff repeating an adult arrival keeps their second-building visit and supervised minors present',async()=>{
 const other=(await pool.query("SELECT buildingid FROM building WHERE name='Family second building'")).rows[0].buildingid;
 await transaction(pool,async db=>{
  await new MinorSupervision(db).startVisit(adult.user.id,other);
  await new MinorSupervision(db).startVisit(minor.user.id,other);
 });
 const opened=await post(admin,'/admin/account-mode',{userId:adult.user.id});
 assert.equal(opened.status,200);admin.csrfToken=opened.body.data.csrfToken;
 try {
  const overview=await request(server).get('/api/me/overview').set('Authorization','Bearer '+admin.accessToken);
  assert.equal(overview.body.data.checkInBuildingId,other);
  assert.equal(overview.body.data.canCheckIn,true);
  const checked=await post(admin,'/me/check-ins');
  assert.equal(checked.status,201,JSON.stringify(checked.body));
 } finally {
  const closed=await post(admin,'/admin/account-mode/end');
  assert.equal(closed.status,200);admin.csrfToken=closed.body.data.csrfToken;
 }
 const visits=(await pool.query('SELECT user_id,building_id FROM app_facility_visit WHERE user_id=ANY($1::int[]) AND checked_out_at IS NULL ORDER BY user_id',[[adult.user.id,minor.user.id]])).rows;
 assert.deepEqual(visits.map(v=>v.user_id),[adult.user.id,minor.user.id].sort((a,b)=>a-b));
 assert.ok(visits.every(v=>v.building_id===other));
 const renewed=await transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'building',resourceId:other},minor.user.id,true));
 assert.equal(renewed.allowed,true,JSON.stringify(renewed));
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
const outbox=async(id:number)=>(await pool.query(`SELECT userid,kind,status,payload FROM app_notification_outbox
 WHERE dedupe_key LIKE $1 ORDER BY id`,[`sponsor-request:${id}:%`])).rows;
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
 // The minor hears about it by email, by the adult's first name only.
 assert.deepEqual(await outbox(id),[{userid:kid.user.id,kind:'sponsor_request_received',status:'pending',payload:{adultName:'Link'}}]);
 assert.equal((await ask(parent)).body.error.code,'REQUEST_PENDING');
 assert.deepEqual((await get(parent,'/me/minors')).body.data.requests.map((r:any)=>[r.id,r.minorName]),[[id,'Link']]);
 assert.deepEqual((await get(kid,'/me/supervision')).body.data.pendingRequests.map((r:any)=>[r.id,r.adultName]),[[id,'Link parent']]);
 for(const who of [other,parent])assert.equal((await post(who,`/me/sponsor-requests/${id}/accept`)).status,404,'only the request minor can accept');
 assert.equal((await post(kid,`/me/sponsor-requests/${id}/accept`,{},false)).status,403,'CSRF required');
 const competing=await ask(other);assert.equal(competing.status,201);
 assert.equal((await outbox(competing.body.data.id)).length,1);
 await pool.query('INSERT INTO app_facility_visit(user_id,building_id) VALUES($1,1)',[kid.user.id]);
 const busy=await post(kid,`/me/sponsor-requests/${id}/accept`);assert.equal(busy.status,409);assert.equal(busy.body.error.code,'CHECK_OUT_FIRST');
 await pool.query('UPDATE app_facility_visit SET checked_out_at=now() WHERE user_id=$1 AND checked_out_at IS NULL',[kid.user.id]);
 const accepted=await post(kid,`/me/sponsor-requests/${id}/accept`);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 assert.equal(accepted.body.data.sponsor.id,parent.user.id);assert.deepEqual(accepted.body.data.pendingRequests,[]);
 assert.deepEqual((await pool.query('SELECT id::int,status FROM app_minor_sponsor_request WHERE minor_id=$1 ORDER BY id',[kid.user.id])).rows,
  [{id,status:'accepted'},{id:competing.body.data.id,status:'cancelled'}]);
 // The adult is told; unsent invitations for every resolved request are withdrawn, and the withdrawn adult gets nothing.
 assert.deepEqual(await outbox(id),[{userid:kid.user.id,kind:'sponsor_request_received',status:'obsolete',payload:{adultName:'Link'}},
  {userid:parent.user.id,kind:'sponsor_request_accepted',status:'pending',payload:{minorName:'Link'}}]);
 assert.deepEqual((await outbox(competing.body.data.id)).map(n=>[n.kind,n.status]),[['sponsor_request_received','obsolete']]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_staff_audit WHERE actor_id=$1 AND subject_id=$1 AND action='minor.sponsor_linked'",[kid.user.id])).rows[0].n,1);
 assert.equal((await post(kid,`/me/sponsor-requests/${id}/accept`)).status,404,'resolved requests cannot be replayed');
 assert.equal((await ask(parent)).body.error.code,'ALREADY_LINKED');
 // Self-service never replaces an existing sponsor: neither a new request nor a stale one accepted later.
 const taken=await ask(other);assert.equal(taken.status,409);assert.equal(taken.body.error.code,'SPONSOR_EXISTS');
 const stale=(await pool.query('INSERT INTO app_minor_sponsor_request(minor_id,adult_id) VALUES($1,$2) RETURNING id::int',[kid.user.id,other.user.id])).rows[0].id;
 const swap=await post(kid,`/me/sponsor-requests/${stale}/accept`);assert.equal(swap.status,409);assert.equal(swap.body.error.code,'SPONSOR_EXISTS');
 assert.deepEqual(await outbox(stale),[],'a rejected answer sends nothing');
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
 assert.deepEqual((await outbox(again.body.data.id)).map(n=>[n.userid,n.kind,n.status]),[[kid.user.id,'sponsor_request_received','obsolete']],'cancel notifies no one');
 assert.equal((await post(kid,`/me/sponsor-requests/${again.body.data.id}/accept`)).status,404,'cancelled requests cannot be accepted');
 const declinable=await ask(other);assert.equal(declinable.status,201);
 // An adult who opted out of email keeps that choice for this notice too.
 await pool.query('INSERT INTO app_notification_preferences(userid,enabled) VALUES($1,false)',[other.user.id]);
 const declined=await post(kid,`/me/sponsor-requests/${declinable.body.data.id}/decline`);assert.equal(declined.status,200);
 assert.deepEqual(await outbox(declinable.body.data.id),[{userid:kid.user.id,kind:'sponsor_request_received',status:'obsolete',payload:{adultName:'Link'}},
  {userid:other.user.id,kind:'sponsor_request_declined',status:'suppressed',payload:{minorName:'Link'}}]);
 await pool.query('UPDATE app_notification_preferences SET enabled=true WHERE userid=$1',[other.user.id]);
 const declinedAgain=await ask(other);assert.equal(declinedAgain.status,201);
 assert.equal((await post(kid,`/me/sponsor-requests/${declinedAgain.body.data.id}/decline`)).status,200);
 assert.deepEqual((await outbox(declinedAgain.body.data.id)).map(n=>[n.userid,n.kind,n.status]),
  [[kid.user.id,'sponsor_request_received','obsolete'],[other.user.id,'sponsor_request_declined','pending']]);
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

test('sponsor requests run on a single-connection pool and still record matched details after a 409',async()=>{
 // One connection: a request that asks the pool for a second client mid-transaction stalls and fails.
 const single=new Pool({database,max:1,connectionTimeoutMillis:2000});
 const app3=createApp(single,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 const server3=app3.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server3.once('listening',resolve));
 try {
  const password='GoodPassword123!',ids:Record<string,number>={};
  for (const [email,dob] of [['single.parent@example.invalid','1979-04-04'],['single.kid@example.invalid','2013-05-05']]) {
   ids[email]=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
    VALUES('Single','Pool',$1,$2,'1112223333',$3,'active',true) RETURNING userid`,[email,await hashPassword(password),dob])).rows[0].userid;
   await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[ids[email]]);
  }
  const parent=(await request(server3).post('/api/auth/login').send({email:'single.parent@example.invalid',password})).body.data;
  const ask=()=>request(server3).post('/api/me/minors/requests').set('Authorization','Bearer '+parent.accessToken)
   .set('X-CSRF-Token',parent.csrfToken).send({email:'single.kid@example.invalid',dob:'2013-05-05'});
  const created=await ask();assert.equal(created.status,201,JSON.stringify(created.body));
  const pending=await ask();assert.equal(pending.status,409,JSON.stringify(pending.body));assert.equal(pending.body.error.code,'REQUEST_PENDING');
  assert.deepEqual((await pool.query('SELECT matched FROM app_minor_sponsor_attempt WHERE adult_id=$1 ORDER BY id',[ids['single.parent@example.invalid']])).rows.map(r=>r.matched),
   [true,true],'a rolled-back 409 still counts as a match, not a miss');
 } finally {await new Promise<void>(r=>{server3.close(r);server3.closeAllConnections();});await single.end();}
});

// Review regressions share one linked, entitled adult/minor pair; each starts with the adult checked in.
let pair:{parent:any,kid:any}|undefined;
async function family(){
 if(!pair){
  const parent=await account('review.parent@example.invalid','1980-01-01'),kid=await account('review.kid@example.invalid','2012-01-01');
  for(const who of [parent,kid]){
   await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
    VALUES($1,1,(now()-interval '1 day') AT TIME ZONE 'UTC',(now()+interval '30 days') AT TIME ZONE 'UTC','active')`,[who.user.id]);
   await sign(who);
  }
  await pool.query('INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2)',[kid.user.id,parent.user.id]);
  pair={parent,kid};
 }
 await transaction(pool,db=>new MinorSupervision(db).startVisit(pair!.parent.user.id,1));
 return {parent:pair.parent.user.id as number,kid:pair.kid.user.id as number,kidSession:pair.kid,parentSession:pair.parent};
}
const fixtureRoom=async(name:string)=>(await pool.query("INSERT INTO room(name,location,status,capacity) VALUES($1,'Fixture','available',15) RETURNING roomid",[name])).rows[0].roomid as number;
test('class enrollment locks the member before sponsor rows, so sponsor changes queue instead of deadlocking',async()=>{
 const {kid,kidSession}=await family();
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin.user.id]);
 const catalog=(await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id,start=Date.now()+2*86400000;
 const created=await post(admin,'/classes',{title:'Lock order class',catalogId:catalog,instructorId:admin.user.id,roomId:await fixtureRoom('Lock order classroom'),capacity:15,
  startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),reason:'Lock order regression'});
 assert.equal(created.status,201,JSON.stringify(created.body));
 // Instructor accounts cannot book; later tests have the admin edit reservations.
 await pool.query("DELETE FROM user_role WHERE userid=$1 AND roleid=(SELECT roleid FROM role WHERE role='instructor')",[admin.user.id]);
 const blocker=await pool.connect();let enrolling:Promise<any>|undefined,queued=false;
 try {
  // Stand in for sponsor unlink/accept/staff relink: minor user row FOR UPDATE, then the sponsor row.
  await blocker.query('BEGIN');
  await blocker.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[kid]);
  enrolling=post(kidSession,`/classes/${created.body.data.id}/enroll`).then(r=>r);
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&!queued){
   queued=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount;
   if(!queued)await delay(10);
  }
  // Enrollment used to take the sponsor row FOR SHARE first and then wait on the user row
  // for its foreign key, so this second lock deadlocked (40P01). Now it must be free.
  await blocker.query('SELECT minor_id FROM app_minor_sponsor WHERE minor_id=$1 FOR UPDATE NOWAIT',[kid]);
 } finally {await blocker.query('ROLLBACK');blocker.release();}
 assert.ok(queued,'enrollment waited behind the user row lock');
 const enrolled=await enrolling!;assert.equal(enrolled.status,200,JSON.stringify(enrolled.body));
});
test('visit check-outs never end before a check-in committed after the transaction began',async()=>{
 const {parent,kid}=await family();
 const db=await pool.connect();
 try {
  await db.query('BEGIN');await db.query('SELECT now()');await delay(20);
  // Stands in for a visit committed just after local midnight by a transaction that began before it:
  // startVisit treats it as a previous-day visit and must still end it no earlier than it began.
  await pool.query("INSERT INTO app_facility_visit(user_id,building_id,sponsor_id,checked_in_at) VALUES($1,1,$2,clock_timestamp()+interval '1 day')",[kid,parent]);
  await new MinorSupervision(db).startVisit(kid,1);
  await db.query('COMMIT');
  await db.query('BEGIN');await db.query('SELECT now()');await delay(20);
  // A minor check-in commits after the adult's checkout transaction began (it waited on the adult visit).
  await pool.query('UPDATE app_facility_visit SET checked_in_at=clock_timestamp() WHERE user_id=$1 AND checked_out_at IS NULL',[kid]);
  const out=await new MinorSupervision(db).checkout(parent);
  await db.query('COMMIT');
  assert.deepEqual(out.checkedOut.map((r:any)=>r.userId).sort((a:number,b:number)=>a-b),[parent,kid].sort((a,b)=>a-b));
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=ANY($1::int[]) AND checked_out_at IS NULL',[[parent,kid]])).rows[0].n,0);
});
test('staff supervised access for a minor links the new booking to the present sponsor',async()=>{
 const {parent,kid}=await family();
 const space=await fixtureRoom('Supervised override room');
 const r=await post(admin,'/admin/access/overrides',{userId:kid,kind:'room',resourceId:space,durationMinutes:10,reason:'Supervised minor access'});
 assert.equal(r.status,201,JSON.stringify(r.body));
 assert.equal((await pool.query('SELECT adult_id FROM app_minor_booking WHERE reservation_id=$1',[r.body.data.reservationid])).rows[0]?.adult_id,parent);
 const verdict=await transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:space},kid));
 assert.equal(verdict.allowed,true,JSON.stringify(verdict));
});
test('a minor can replay a created studio rental after the sponsor leaves; new rentals still need them',async()=>{
 const {parent,kid}=await family();
 const studios=new StudioService(pool),studio=(await pool.query('SELECT id,revision FROM app_studio ORDER BY id LIMIT 1')).rows[0];
 await studios.configure(admin.user.id,studio.id,{monthlyCents:20000,cancellationPolicy:'full_before_start',policyConfirmed:true,revision:studio.revision});
 const body={studioId:studio.id,startDate:'2030-01-31',paymentMethod:'manual',requestKey:randomUUID(),
  expectedRevision:(await pool.query('SELECT revision FROM app_studio WHERE id=$1',[studio.id])).rows[0].revision};
 const rental=await studios.create(kid,body);
 assert.equal((await pool.query('SELECT adult_id FROM app_minor_studio_booking WHERE rental_id=$1',[rental.id])).rows[0].adult_id,parent);
 await transaction(pool,db=>new MinorSupervision(db).checkout(parent));
 assert.equal((await studios.create(kid,body)).id,rental.id,'the same request key replays the created rental');
 await assert.rejects(studios.create(kid,{...body,startDate:'2030-03-31',requestKey:randomUUID()}),{code:'SPONSOR_REQUIRED'});
});
test("staff can move a minor's booking while the sponsor is away; the sponsor link is kept",async()=>{
 const {parent,kid,kidSession}=await family();
 const space=await fixtureRoom('Staff move room'),start=Date.now()+86400000,at=(ms:number)=>new Date(ms).toISOString();
 const booked=await post(kidSession,'/reservations',{roomId:space,startTime:at(start),endTime:at(start+3600000)});
 assert.equal(booked.status,201,JSON.stringify(booked.body));
 const id=booked.body.data.id,revision=(await pool.query('SELECT revision FROM reservation WHERE reservationid=$1',[id])).rows[0].revision;
 await transaction(pool,db=>new MinorSupervision(db).checkout(parent));
 const moved=await request(server).patch(`/api/admin/reservations/${id}`).set('Authorization','Bearer '+admin.accessToken).set('X-CSRF-Token',admin.csrfToken)
  .send({startTime:at(start+7200000),endTime:at(start+10800000),expectedRevision:revision});
 assert.equal(moved.status,200,JSON.stringify(moved.body));
 assert.equal((await pool.query('SELECT adult_id FROM app_minor_booking WHERE reservation_id=$1',[id])).rows[0]?.adult_id,parent);
});
test('a previous-day open visit does not block sponsor changes the summary allows',async()=>{
 const {parent,kid,kidSession,parentSession}=await family();
 const stale=()=>pool.query("INSERT INTO app_facility_visit(user_id,building_id,sponsor_id,checked_in_at) VALUES($1,1,$2,now()-interval '1 day')",[kid,parent]);
 await stale();
 assert.equal((await get(kidSession,'/me/supervision')).body.data.visit,null,'the summary hides previous-day visits');
 const revision=(await pool.query('SELECT revision FROM app_minor_sponsor WHERE minor_id=$1',[kid])).rows[0].revision;
 const relinked=await post(admin,`/admin/users/${kid}/supervision`,{adultId:parent,revision,consent:true,reason:'Confirmed sponsor at desk'});
 assert.equal(relinked.status,200,JSON.stringify(relinked.body));
 await stale();
 const unlinked=await post(parentSession,`/me/minors/${kid}/unlink`);assert.equal(unlinked.status,200,JSON.stringify(unlinked.body));
 await stale();
 const requestId=(await pool.query('INSERT INTO app_minor_sponsor_request(minor_id,adult_id) VALUES($1,$2) RETURNING id::int',[kid,parent])).rows[0].id;
 const accepted=await post(kidSession,`/me/sponsor-requests/${requestId}/accept`);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[kid])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=$1 AND checked_out_at<checked_in_at',[kid])).rows[0].n,0);
});
test('minor status and supervision use the configured time zone, not New York',async()=>{
 // Kiritimati (UTC+14) is always at least a day ahead of Pago Pago (UTC-11): this account turns 18 today there only.
 const password='GoodPassword123!',email='zone.birthday@example.invalid';
 const id=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
  VALUES('Zone','Birthday',$1,$2,'1112223333',((now() AT TIME ZONE 'Pacific/Kiritimati')::date-INTERVAL '18 years')::date,'active',true) RETURNING userid`,[email,await hashPassword(password)])).rows[0].userid;
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[id]);
 for(const [timeZone,isMinor] of [['Pacific/Kiritimati',false],['Pacific/Pago_Pago',true]] as const){
  const zoned=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone});
  const login=await request(zoned).post('/api/auth/login').send({email,password});assert.equal(login.status,200,JSON.stringify(login.body));
  assert.equal(login.body.data.user.isMinor,isMinor,timeZone);
  const session=await request(zoned).get('/api/auth/session').set('Authorization','Bearer '+login.body.data.accessToken);
  assert.equal(session.body.data.user.isMinor,isMinor,timeZone);
 }
 // Portal check-ins start the visit with the same zone: an adult there needs no sponsor.
 await assert.rejects(transaction(pool,db=>new MemberModel(db,'Pacific/Pago_Pago').createCheckIn(id,'Fixture',null,1)),{code:'SPONSOR_REQUIRED'});
 await transaction(pool,db=>new MemberModel(db,'Pacific/Kiritimati').createCheckIn(id,'Fixture',null,1));
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[id])).rows[0].n,1);
});
test('an eligible adult cannot make themselves present from the web; staff at the desk can',async()=>{
 // A web check-in starts the adult's visit, and that visit is what lets their sponsored minor in.
 const parent=await account('web.parent@example.invalid','1980-01-01'),kid=await account('web.kid@example.invalid','2012-01-01');
 for(const who of [parent,kid]){
  await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status)
   VALUES($1,1,(now()-interval '1 day') AT TIME ZONE 'UTC',(now()+interval '30 days') AT TIME ZONE 'UTC','active')`,[who.user.id]);
  await sign(who);
 }
 await pool.query('INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2)',[kid.user.id,parent.user.id]);
 const space=await fixtureRoom('Web check-in room'),kidSpace=await fixtureRoom('Web check-in kid room');
 const book=async(userId:number,roomId:number)=>(await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
  VALUES($1,$2,'Fixture',(now()-interval '1 minute') AT TIME ZONE 'UTC',(now()+interval '30 minutes') AT TIME ZONE 'UTC','confirmed') RETURNING reservationid`,[userId,roomId])).rows[0].reservationid;
 await book(parent.user.id,space);
 await pool.query('INSERT INTO app_minor_booking(reservation_id,adult_id) VALUES($1,$2)',[await book(kid.user.id,kidSpace),parent.user.id]);
 const presence=async()=>({
  checkIns:(await pool.query('SELECT count(*)::int n FROM check_in WHERE userid=$1',[parent.user.id])).rows[0].n,
  visits:(await pool.query('SELECT count(*)::int n FROM app_facility_visit WHERE user_id=$1',[parent.user.id])).rows[0].n,
 });
 const atReader=(userId:number,roomId:number)=>transaction(pool,db=>evaluateReaderAccess(db,'America/New_York',{kind:'room',resourceId:roomId},userId));
 // The adult is otherwise fully eligible: entitlement, signed policies and a current booking.
 assert.equal((await atReader(parent.user.id,space)).allowed,true);
 for(const [path,body] of [['/me/check-ins',{roomId:space}],['/me/check-ins',{}],['/ME/CHECK-INS',{roomId:space}],['/me/check-ins/',{buildingId:1}]] as const){
  const r=await post(parent,path,body);
  assert.equal(r.status,403,`${path} ${JSON.stringify(r.body)}`);assert.equal(r.body.error.code,'CHECK_IN_AT_READER');
 }
 assert.deepEqual(await presence(),{checkIns:0,visits:0});
 await assert.rejects(transaction(pool,db=>new MinorSupervision(db).requireSponsor(kid.user.id)),{code:'SPONSOR_REQUIRED'});
 const denied=await atReader(kid.user.id,kidSpace);assert.equal(denied.allowed,false);assert.equal(denied.reason,'SPONSOR_REQUIRED');
 // Staff at the desk, in the adult's open account, may check them in.
 const opened=await post(admin,'/admin/account-mode',{userId:parent.user.id});assert.equal(opened.status,200,JSON.stringify(opened.body));
 const checkedIn=await post({...admin,csrfToken:opened.body.data.csrfToken},'/me/check-ins',{roomId:space});
 const closed=await post({...admin,csrfToken:opened.body.data.csrfToken},'/admin/account-mode/end');
 assert.equal(checkedIn.status,201,JSON.stringify(checkedIn.body));assert.equal(closed.status,200,JSON.stringify(closed.body));
 assert.equal((await pool.query('SELECT userid FROM check_in WHERE checkinid=$1',[checkedIn.body.data.id])).rows[0].userid,parent.user.id);
 assert.deepEqual(await presence(),{checkIns:1,visits:1});
 assert.equal((await transaction(pool,db=>new MinorSupervision(db).requireSponsor(kid.user.id)))?.id,parent.user.id);
 const allowed=await atReader(kid.user.id,kidSpace);assert.equal(allowed.allowed,true,JSON.stringify(allowed));
 await transaction(pool,db=>new MinorSupervision(db).checkout(parent.user.id));
});
