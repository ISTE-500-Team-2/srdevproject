import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {PassBilling} from '../../src/billing/passes.js';
import {membershipTrends} from '../../src/membershipReports.js';
import {StaffModel} from '../../src/models/StaffModel.js';
import {MemberModel} from '../../src/models/MemberModel.js';
import {StaffService} from '../../src/services/StaffService.js';
import {scheduleExpirationNotifications} from '../../src/notifications/scheduler.js';
import {checkReaderHealth} from '../../src/serviceNotices.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {StudioStripe} from '../../src/studios/stripe.js';

const database='arbor_'+randomBytes(6).toString('hex')+'_gaps_mvc_test';
const adminPool=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
let checkout:any;
(provider.sdk.checkout.sessions.retrieve as any)=async()=>checkout;
let created=false;let app:ReturnType<typeof createApp>;
type Actor={id:number;token:string;csrf:string};
let member:Actor;let administrator:Actor;let staffId:number;
async function login(role:string):Promise<Actor>{const r=await request(app).post('/api/auth/demo').send({role});assert.equal(r.status,200);return {id:r.body.data.user.id,token:r.body.data.accessToken,csrf:r.body.data.csrfToken};}
const get=(path:string,actor:Actor)=>request(app).get('/api'+path).set('Authorization','Bearer '+actor.token);
const post=(path:string,body:unknown,actor:Actor)=>request(app).post('/api'+path).set('Authorization','Bearer '+actor.token).set('X-CSRF-Token',actor.csrf).send(body as object);
const patch=(path:string,body:unknown,actor:Actor)=>request(app).patch('/api'+path).set('Authorization','Bearer '+actor.token).set('X-CSRF-Token',actor.csrf).send(body as object);
const DAY=86_400_000;
const report=async()=>{const today=new Date().toISOString().slice(0,10);const r=await get(`/admin/reports?from=${today}&to=${today}`,administrator);assert.equal(r.status,200);return r.body.data;};
const emails=async(kind:string,userId:number)=>(await pool.query('SELECT status,payload,counts_for_sla,due_at,deadline_at FROM app_notification_outbox WHERE kind=$1 AND userid=$2 ORDER BY id',[kind,userId])).rows;
async function membership(userId:number,startOffsetDays:number,endOffsetDays:number){
 const plan=await new StaffModel(pool).plan((await pool.query("SELECT tierid FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0].tierid);
 return new StaffModel(pool).createMembership(userId,plan!,new Date(Date.now()+startOffsetDays*DAY).toISOString(),new Date(Date.now()+endOffsetDays*DAY),administrator.id,'Requirement gap fixture');
}
async function freshUser(label:string){
 return (await pool.query(`INSERT INTO "user"(firstname,lastname,email,phone,password,status,accessstatus,email_confirmed)
  VALUES('Gap',$1,$2,'5550100','fixture-not-a-login','active','active',true) RETURNING userid`,[label,`${label}.${randomBytes(3).toString('hex')}@collaboratory.invalid`])).rows[0].userid as number;
}
async function grantRole(userId:number,role:string){
 await pool.query(`INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role=$2 ON CONFLICT DO NOTHING`,[userId,role]);
}
async function reader(id:string,lastSeenMinutesAgo:number|null,enabled=true){
 await pool.query(`INSERT INTO app_access_reader(id,name,kind,resource_id,secret_encrypted,enabled,last_seen_at) VALUES($1,$2,'building',1,'fixture',$3,$4)`,
  [id,'Reader '+id,enabled,lastSeenMinutesAgo===null?null:new Date(Date.now()-lastSeenMinutesAgo*60_000)]);
}
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
 await adminPool.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 member=await login('member');administrator=await login('admin');
 staffId=await freshUser('Staff');await grantRole(staffId,'staff');
});
after(async()=>{await pool.end();if(created)await adminPool.query(`DROP DATABASE "${database}"`);await adminPool.end();});

test('FR-033: a failed delayed day-pass payment emails the member once',async()=>{
 const userId=await freshUser('PassFailed');const id=randomUUID();
 await pool.query(`INSERT INTO app_pass_checkout(id,userid,tierid,plan_snapshot,valid_date,amount_cents,status,checkout_id)
  SELECT $1,$2,tierid,jsonb_build_object('name',tiername),CURRENT_DATE+30,2500,'pending','cs_failed_pass' FROM membership_tiers WHERE kind='day_pass' LIMIT 1`,[id,userId]);
 checkout={id:'cs_failed_pass',livemode:false,status:'complete',mode:'payment',payment_status:'unpaid',amount_total:2500,currency:'usd',client_reference_id:id,metadata:{dayPassCheckoutId:id}};
 const passes=new PassBilling(pool,provider);
 const event=()=>({id:'evt_'+randomUUID(),livemode:false,type:'checkout.session.async_payment_failed',data:{object:checkout}} as any);
 await passes.webhook(event());await passes.webhook(event());
 assert.equal((await pool.query('SELECT status FROM app_pass_checkout WHERE id=$1',[id])).rows[0].status,'expired');
 const sent=await emails('payment_failed',userId);
 assert.equal(sent.length,1);assert.equal(sent[0].status,'pending');
 assert.ok(sent[0].payload.planName);assert.match(sent[0].payload.instructions,/not been charged|did not go through|try again/i);
});

test('FR-073: the report counts only memberships active right now',async()=>{
 const before=(await report()).compliance.activeMemberships;
 assert.equal(typeof before,'number');
 const current=await freshUser('Current'),future=await freshUser('Future'),past=await freshUser('Past');
 await membership(current,-1,20);await membership(future,5,20);await membership(past,-30,-1);
 assert.equal((await report()).compliance.activeMemberships,before+1);
});

test('B-013: the report names bookable machines with no training requirement',async()=>{
 const name='Unlinked '+randomBytes(3).toString('hex');
 await pool.query(`INSERT INTO equipment(name,category,status,location) VALUES($1,'Saw','available','Shop')`,[name]);
 const off='Offline '+randomBytes(3).toString('hex');
 await pool.query(`INSERT INTO equipment(name,category,status,location) VALUES($1,'Saw','unavailable','Shop')`,[off]);
 const names=(await report()).compliance.machinesWithoutTraining as string[];
 assert.ok(names.includes(name));assert.ok(!names.includes(off));
});

async function cert(validityDays:number|null){
 return (await pool.query(`INSERT INTO certifications(certid,name,description,effectivedate,validity_days)
  SELECT COALESCE(MAX(certid),0)+1,$1,'Fixture',NOW() AT TIME ZONE 'UTC',$2 FROM certifications RETURNING certid,revision`,['Gap cert '+randomBytes(3).toString('hex'),validityDays])).rows[0];
}
const grant=async(userId:number,certid:number,trainedAt:Date|null)=>(await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,trained_at)
  SELECT COALESCE(MAX(usercertid),0)+1,$1,$2,'active',$3 FROM user_certifications RETURNING usercertid`,[userId,certid,trainedAt])).rows[0].usercertid as number;
const renewal=async(id:number)=>(await pool.query(`SELECT renewaldate AT TIME ZONE 'UTC' AS at FROM user_certifications WHERE usercertid=$1`,[id])).rows[0].at as Date|null;

test('B-014: setting a validity period dates older certifications from their training date',async()=>{
 const c=await cert(null),id=await grant(await freshUser('Legacy'),c.certid,new Date(Date.now()-10*DAY));
 assert.ok((await report()).compliance.trainingWithoutExpiry>=1);
 const saved=await patch(`/training/catalog/${c.certid}`,{name:'Validity set '+c.certid,description:'',validityDays:100,equipmentIds:[],expectedRevision:c.revision,reason:'Sponsor approved validity'},administrator);
 assert.equal(saved.status,200);
 const at=await renewal(id);
 assert.ok(at);assert.ok(Math.abs(at.getTime()-(Date.now()+90*DAY))<60_000);
});

test('B-014: the backfill starts the clock today when no training date was recorded and leaves dated records alone',async()=>{
 const c=await cert(30),undated=await grant(await freshUser('Undated'),c.certid,null);
 const datedUser=await freshUser('Dated'),dated=await grant(datedUser,c.certid,new Date());
 const fixed=new Date('2040-01-01T00:00:00Z');
 await pool.query(`UPDATE user_certifications SET renewaldate=$2 AT TIME ZONE 'UTC' WHERE usercertid=$1`,[dated,fixed]);
 await pool.query('SELECT app_backfill_certification_expiry($1)',[c.certid]);
 const at=await renewal(undated);
 assert.ok(at);assert.ok(Math.abs(at.getTime()-(Date.now()+30*DAY))<60_000);
 assert.equal((await renewal(dated))!.getTime(),fixed.getTime());
});
test('B-014: backfill uses the same elapsed-day validity as training issuance across database time zones',async()=>{
 const trained=new Date('2026-10-28T12:00:00Z'),c=await cert(30),id=await grant(await freshUser('DstBackfill'),c.certid,trained);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL TIME ZONE 'America/New_York'");
  await db.query('SELECT app_backfill_certification_expiry($1)',[c.certid]);
  const expiry=(await db.query(`SELECT renewaldate AT TIME ZONE 'UTC' AS expires FROM user_certifications WHERE usercertid=$1`,[id])).rows[0].expires;
  assert.equal(expiry.getTime(),trained.getTime()+30*DAY);
 }finally{await db.query('ROLLBACK');db.release();}
});

const policyBody=(name:string,extra:object={})=>({name,version:'v1',description:'Plain test wording for this waiver.',effectiveAt:new Date(Date.now()-60_000).toISOString(),approvalReference:'Sponsor ticket 1',reason:'Publish for test',...extra});

test('B-015: a waiver published with a duration expires that long after signing',async()=>{
 const name='Timed waiver '+randomBytes(3).toString('hex');
 const published=await post('/admin/policies',policyBody(name,{validityDays:365}),administrator);
 assert.equal(published.status,201);assert.equal(published.body.data.validityDays,365);
 assert.equal((await post(`/me/waivers/${published.body.data.id}/sign`,{accepted:true},member)).status,200);
 const row=(await pool.query('SELECT userwaiverid,expires_at,signdate AT TIME ZONE \'UTC\' AS signed FROM user_waiver WHERE userid=$1 AND waiverid=$2',[member.id,published.body.data.id])).rows[0];
 assert.ok(row.expires_at);assert.ok(Math.abs(new Date(row.expires_at).getTime()-new Date(row.signed).getTime()-365*DAY)<5000);
 assert.equal((await emails('waiver_expiring',member.id)).filter(m=>m.payload.sourceId===row.userwaiverid).length,0,'Keep long-term expirations outside the existing 30-day scheduling horizon');
});
test('B-015: signature validity lasts the configured elapsed days regardless of database time zone',async()=>{
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL TIME ZONE 'America/New_York'");
  for(const days of [90,180,270]){
   const waiver=(await db.query(`INSERT INTO waiver(name,version,description,validity_days) VALUES($1,'v1','Timezone fixture',$2) RETURNING waiverid`,['Timezone '+days,days])).rows[0].waiverid;
   const signed=await new MemberModel(db).signWaiver(member.id,waiver);
   assert.ok(signed);
   const expiry=(await db.query('SELECT expires_at FROM user_waiver WHERE userwaiverid=$1',[signed.id])).rows[0].expires_at;
   assert.equal(expiry.getTime()-new Date(signed.signedAt).getTime(),days*DAY);
  }
 }finally{await db.query('ROLLBACK');db.release();}
});

test('B-015: a waiver with no duration does not invent an expiry, and bad durations are refused',async()=>{
 const name='Open waiver '+randomBytes(3).toString('hex');
 const published=await post('/admin/policies',policyBody(name),administrator);
 assert.equal(published.status,201);assert.equal(published.body.data.validityDays,null);
 assert.equal((await post(`/me/waivers/${published.body.data.id}/sign`,{accepted:true},member)).status,200);
 assert.equal((await pool.query('SELECT expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2',[member.id,published.body.data.id])).rows[0].expires_at,null);
 for(const validityDays of [0,-1,3651,'soon',1.5])
  assert.equal((await post('/admin/policies',policyBody(name+validityDays,{validityDays}),administrator)).status,400,String(validityDays));
});
test('B-015/BR-010: signing a one-day waiver queues its short-notice reminder before the next daily scan',async()=>{
 const published=await post('/admin/policies',policyBody('One-day '+randomBytes(3).toString('hex'),{validityDays:1}),administrator);
 assert.equal(published.status,201);
 const id=published.body.data.id;
 assert.equal((await post(`/me/waivers/${id}/sign`,{accepted:true},member)).status,200);
 const signature=(await pool.query('SELECT userwaiverid,expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 AND approval=true',[member.id,id])).rows[0];
 const reminders=async()=>(await emails('waiver_expiring',member.id)).filter(m=>m.payload.sourceId===signature.userwaiverid);
 const queued=await reminders();
 assert.equal(queued.length,1);
 assert.equal(queued[0].status,'pending');assert.equal(queued[0].counts_for_sla,false);
 assert.ok(new Date(queued[0].due_at)<=new Date());
 assert.equal(queued[0].payload.expiresAt,signature.expires_at.toISOString());
 assert.equal((await post(`/me/waivers/${id}/sign`,{accepted:true},member)).status,200);
 await scheduleExpirationNotifications(pool);
 assert.equal((await reminders()).length,1);
});

test('B-016: the report counts signatures with no retained copy',async()=>{
 const before=(await report()).compliance.signaturesWithoutCopy;
 assert.equal(typeof before,'number');
 const w=(await pool.query(`INSERT INTO waiver(name,version,description,effectivedate) VALUES($1,'v1','Legacy wording for this fixture',NOW() AT TIME ZONE 'UTC') RETURNING waiverid`,['Legacy '+randomBytes(3).toString('hex')])).rows[0].waiverid;
 await pool.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval) VALUES($1,$2,NOW() AT TIME ZONE 'UTC',true)`,[await freshUser('LegacySigner'),w]);
 assert.equal((await report()).compliance.signaturesWithoutCopy,before+1);
});

test('BR-010: a short-notice grant is still sent but cannot count as a missed week of notice',async()=>{
 const now=new Date();
 const c=await cert(3),userId=await freshUser('ShortNotice'),id=await grant(userId,c.certid,now);
 await pool.query(`UPDATE user_certifications SET approved_at=$2,renewaldate=$3 AT TIME ZONE 'UTC' WHERE usercertid=$1`,[id,now,new Date(now.getTime()+3*DAY)]);
 await scheduleExpirationNotifications(pool,now);
 const sent=await emails('certification_expiring',userId);
 assert.equal(sent.length,1);assert.equal(sent[0].status,'pending');assert.ok(new Date(sent[0].due_at)<=now);
 assert.equal(sent[0].counts_for_sla,false);
});

test('BR-010: a record granted in time still counts when the reminder runs late',async()=>{
 const now=new Date();
 const c=await cert(90),userId=await freshUser('LateScan'),id=await grant(userId,c.certid,new Date(now.getTime()-87*DAY));
 await pool.query(`UPDATE user_certifications SET approved_at=$2,renewaldate=$3 AT TIME ZONE 'UTC' WHERE usercertid=$1`,[id,new Date(now.getTime()-87*DAY),new Date(now.getTime()+3*DAY)]);
 await scheduleExpirationNotifications(pool,now);
 assert.equal((await emails('certification_expiring',userId))[0].counts_for_sla,true);
});

async function memberActor(){
 const userId=await freshUser('Canceller');
 await grantRole(userId,'member');
 return userId;
}
test('FR-057: cancelling a long staff-issued membership ends it 30 days from now',async()=>{
 const id=await membership(member.id,-1,200);
 const r=await post(`/me/billing/memberships/${id}/cancel`,{},member);
 assert.equal(r.status,200);
 const row=(await pool.query(`SELECT end_date AT TIME ZONE 'UTC' AS ends,cancellation_requested_at,status FROM user_membership WHERE membershipid=$1`,[id])).rows[0];
 assert.ok(row.cancellation_requested_at);assert.equal(row.status,'active');
 assert.ok(Math.abs(new Date(row.ends).getTime()-(Date.now()+30*DAY))<60_000);
 assert.equal(new Date(r.body.data.endsAt).getTime(),new Date(row.ends).getTime());
 const mail=(await emails('membership_cancelled',member.id)).at(-1);
 assert.ok(mail);assert.ok(mail.payload.endsAt);
 assert.equal((await pool.query(`SELECT 1 FROM app_staff_audit WHERE action='membership.cancelled' AND entity_id=$1`,[id])).rowCount,1);
 const listed=(await get('/me/memberships',member)).body.data.memberships.find((m:any)=>m.id===id);
 assert.ok(listed.cancellationRequestedAt);assert.equal(listed.cardBilled,false);
 const trends=await membershipTrends(pool,new Date(Date.now()-DAY),new Date(Date.now()+DAY),'America/New_York','month');
 assert.ok(trends.some((p:any)=>p.cancelledMembers>=1));
 const again=await post(`/me/billing/memberships/${id}/cancel`,{},member);
 assert.equal(again.status,200);
 assert.equal(new Date(again.body.data.endsAt).getTime(),new Date(row.ends).getTime());
 assert.equal((await emails('membership_cancelled',member.id)).filter(m=>m.payload.membershipId===id).length,1);
 await pool.query(`UPDATE user_membership SET status='revoked' WHERE membershipid=$1`,[id]);
});
test('FR-057: a membership ending inside the notice period keeps its end date',async()=>{
 const id=await membership(member.id,-1,10);
 const expected=(await pool.query(`SELECT end_date FROM user_membership WHERE membershipid=$1`,[id])).rows[0].end_date;
 const r=await post(`/me/billing/memberships/${id}/cancel`,{},member);
 assert.equal(r.status,200);
 const row=(await pool.query(`SELECT end_date,cancellation_requested_at FROM user_membership WHERE membershipid=$1`,[id])).rows[0];
 assert.equal(row.end_date.getTime(),expected.getTime());assert.ok(row.cancellation_requested_at);
 await pool.query(`UPDATE user_membership SET status='revoked' WHERE membershipid=$1`,[id]);
});
test('FR-057: the cancellation notice matches the existing elapsed-day policy across database time zones',async()=>{
 const userId=await memberActor(),id=await membership(userId,-40,200);
 const now=new Date('2026-10-28T12:00:00Z');
 const single=new Pool({database,max:1,connectionTimeoutMillis:5000,options:'-c timezone=America/New_York'});
 // Fix only the transaction clock; execute the service SQL and locks in PostgreSQL.
 const fixedClock={connect:async()=>{
  const db=await single.connect();
  return {release:()=>db.release(),query:(sql:string,values?:unknown[])=>db.query(sql.replaceAll('NOW()',`TIMESTAMPTZ '${now.toISOString()}'`),values)};
 }} as unknown as Pool;
 try{
  await pool.query(`UPDATE user_membership SET startdate=TIMESTAMP '2026-10-01 12:00:00',end_date=TIMESTAMP '2027-02-01 12:00:00' WHERE membershipid=$1`,[id]);
  const cancelled=await new PassBilling(fixedClock).cancelMembership(userId,id);
  assert.equal(new Date(cancelled.endsAt).getTime(),now.getTime()+30*DAY);
 }finally{await single.end();}
});
test('FR-057: other members, card subscriptions and ended memberships cannot be cancelled here',async()=>{
 const other=await memberActor();
 const foreign=await membership(other,-1,60);
 assert.equal((await post(`/me/billing/memberships/${foreign}/cancel`,{},member)).status,404);
 const ended=await membership(member.id,-40,-1);
 assert.equal((await post(`/me/billing/memberships/${ended}/cancel`,{},member)).status,409);
 const carded=await membership(member.id,300,330);
 const model=new StaffModel(pool),payment=await model.createPayment(member.id,carded,'50.00','paid','card','in_gap','Fixture',administrator.id);
 const billing=randomUUID(),tier=(await pool.query('SELECT tierid FROM user_membership WHERE membershipid=$1',[carded])).rows[0].tierid;
 await pool.query(`INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id) VALUES($1,$2,$3,'{"name":"x"}',5000,'canceled','cus_gap','sub_gap')`,[billing,member.id,tier]);
 await pool.query(`INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end) VALUES('in_gap',$1,$2,$3,NOW(),NOW()+INTERVAL '1 month')`,[billing,carded,payment]);
 const card=await post(`/me/billing/memberships/${carded}/cancel`,{},member);
 assert.equal(card.status,409);assert.equal(card.body.error.code,'PROVIDER_PAYMENT');
 assert.equal((await get('/me/memberships',member)).body.data.memberships.find((m:any)=>m.id===carded).cardBilled,true);
});
test('FR-057: cancellation and a staff status change use the same user-before-membership lock order',async()=>{
 const userId=await memberActor(),id=await membership(userId,-1,60);
 let targetLocked!:()=>void,continueStaff!:()=>void;
 const locked=new Promise<void>(resolve=>{targetLocked=resolve;}),proceed=new Promise<void>(resolve=>{continueStaff=resolve;});
 const instrument=(staff:boolean)=>({connect:async()=>{
  const db=await pool.connect();
  return {release:()=>db.release(),query:async(sql:string,values?:unknown[])=>{
   // A user-first canceller waits here while the staff transaction finishes.
   if(!staff&&sql.includes('FROM "user"')&&sql.includes('FOR UPDATE'))continueStaff();
   const result=await db.query(sql,values);
   if(staff&&sql.includes('FOR UPDATE OF u')){targetLocked();await proceed;}
   // The original canceller instead held the membership before waiting on the user.
   if(!staff&&sql.includes('FROM user_membership m')&&sql.includes('FOR UPDATE'))continueStaff();
   return result;
  }};
 }}) as unknown as Pool;
 const status=new StaffService(instrument(true),'America/New_York').entitlementStatus(administrator.id,userId,'membership',id,'suspended',1,'Concurrent staff status change');
 await locked;
 const cancelled=new PassBilling(instrument(false)).cancelMembership(userId,id);
 const [staffResult,cancelResult]=await Promise.allSettled([status,cancelled]);
 assert.equal(staffResult.status,'fulfilled',staffResult.status==='rejected'?String(staffResult.reason):undefined);
 assert.equal(cancelResult.status,'rejected');
 if(cancelResult.status==='rejected')assert.equal(cancelResult.reason.code,'INVALID_STATUS');
 assert.equal((await pool.query('SELECT status,cancellation_requested_at FROM user_membership WHERE membershipid=$1',[id])).rows[0].cancellation_requested_at,null);
});

test('FR-032: an enabled reader going silent alerts staff once and recovery tells them',async()=>{
 const id='gap-reader-'+randomBytes(3).toString('hex');
 await reader(id,10);
 const before=(await emails('system_issue',administrator.id)).length;
 await checkReaderHealth(pool);await checkReaderHealth(pool);
 const alerts=(await emails('system_issue',administrator.id)).filter(m=>m.payload.readerId===id);
 assert.equal(alerts.length,1);assert.match(alerts[0].payload.location,new RegExp(id));
 assert.equal((await emails('system_issue',staffId)).filter(m=>m.payload.readerId===id).length,1);
 assert.equal((await emails('system_issue',member.id)).filter(m=>m.payload.readerId===id).length,0);
 assert.equal((await emails('system_issue',administrator.id)).length,before+1);
 await pool.query('UPDATE app_access_reader SET last_seen_at=NOW() WHERE id=$1',[id]);
 await checkReaderHealth(pool);await checkReaderHealth(pool);
 assert.equal((await emails('service_restored',administrator.id)).filter(m=>m.payload.readerId===id).length,1);
 await pool.query(`UPDATE app_access_reader SET last_seen_at=NOW()-INTERVAL '10 minutes' WHERE id=$1`,[id]);
 await checkReaderHealth(pool);
 assert.equal((await emails('system_issue',administrator.id)).filter(m=>m.payload.readerId===id).length,2);
 await pool.query('UPDATE app_access_reader SET enabled=false WHERE id=$1',[id]);
 const restored=(await emails('service_restored',administrator.id)).length;
 await checkReaderHealth(pool);
 assert.equal((await emails('service_restored',administrator.id)).length,restored);
 assert.equal((await pool.query('SELECT 1 FROM app_service_notice WHERE reader_id=$1 AND resolved_at IS NULL',[id])).rowCount,0);
});
test('FR-032: readers that are healthy, disabled or never connected raise nothing',async()=>{
 const healthy='gap-ok-'+randomBytes(3).toString('hex'),off='gap-off-'+randomBytes(3).toString('hex'),never='gap-new-'+randomBytes(3).toString('hex');
 await reader(healthy,1);await reader(off,60,false);await reader(never,null);
 await checkReaderHealth(pool);
 assert.equal((await pool.query('SELECT 1 FROM app_service_notice WHERE reader_id=ANY($1)',[[healthy,off,never]])).rowCount,0);
});
test('FR-032: an administrator can notify everyone about any issue and then the fix',async()=>{
 const opened=await post('/admin/service-notices',{summary:'The north door reader is down for repair.',reason:'Reported by front desk'},administrator);
 assert.equal(opened.status,201);
 const id=opened.body.data.id;
 const issue=(await emails('system_issue',member.id)).filter(m=>m.payload.noticeId===id);
 assert.equal(issue.length,1);assert.match(issue[0].payload.reason,/north door/);
 assert.equal((await emails('system_issue',staffId)).filter(m=>m.payload.noticeId===id).length,1);
 const open=await get('/admin/service-notices',administrator);
 assert.equal(open.status,200);assert.ok(open.body.data.some((n:any)=>n.id===id&&n.resolvedAt===null&&n.source==='staff'));
 const resolved=await post(`/admin/service-notices/${id}/resolve`,{reason:'Reader replaced'},administrator);
 assert.equal(resolved.status,200);
 assert.equal((await emails('service_restored',member.id)).filter(m=>m.payload.noticeId===id).length,1);
 assert.equal((await post(`/admin/service-notices/${id}/resolve`,{reason:'Reader replaced'},administrator)).status,409);
 assert.equal((await pool.query(`SELECT 1 FROM app_staff_audit WHERE action='service_notice.opened' AND entity_id=$1`,[id])).rowCount,1);
});
test('FR-032: only administrators can send notices, and an empty notice is refused',async()=>{
 assert.equal((await post('/admin/service-notices',{summary:'Member attempting a broadcast',reason:'No'},member)).status,403);
 assert.equal((await get('/admin/service-notices',member)).status,403);
 assert.equal((await post('/admin/service-notices',{summary:'',reason:'Empty'},administrator)).status,400);
});
