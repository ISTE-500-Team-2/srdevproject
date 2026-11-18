import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {configureMvpCatalog} from '../../src/scripts/configure-mvp-catalog.js';
import {hashPassword} from '../../src/passwords.js';
const database='arbor_catalog_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});let server:any,admin:any,room:number,template:number;
const post=(path:string,body:any={},who=admin)=>request(server).post('/api'+path).set('Authorization','Bearer '+who.accessToken).set('X-CSRF-Token',who.csrfToken).send(body);
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);await initializeDemo(pool);
 const app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 admin=(await request(server).post('/api/auth/demo').send({role:'admin'})).body.data;
 await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin.user.id]);
 room=(await pool.query("INSERT INTO room(name,location,status,capacity) VALUES('Catalog fixture','Fixture','available',30) RETURNING roomid")).rows[0].roomid;
 template=(await pool.query('SELECT id FROM app_class_catalog ORDER BY id LIMIT 1')).rows[0].id;
});
after(async()=>{if(server)await new Promise<void>(r=>{server.close(r);server.closeAllConnections();});await pool.end();await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
test('four sponsor templates retain descriptions without fabricated scheduled sessions',async()=>{
 const result=await request(server).get('/api/classes/catalog').set('Authorization','Bearer '+admin.accessToken);
 assert.equal(result.status,200);assert.equal(result.body.data.length,4);
 assert.ok(result.body.data.every((r:any)=>r.description.length>100&&r.capacity===15));
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_training_class')).rows[0].n,0);
});
test('workshops do not falsely grant equipment certification; 16 concurrent enrollments cannot exceed 15',async()=>{
 const start=new Date(Date.now()+86400000),end=new Date(start.getTime()+3600000);
 const body={catalogId:template,title:'Resin fixture',instructorId:admin.user.id,roomId:room,capacity:16,startsAt:start.toISOString(),endsAt:end.toISOString(),reason:'Isolated capacity rehearsal'};
 assert.equal((await post('/classes',body)).status,400);
 const c=await post('/classes',{...body,capacity:15});assert.equal(c.status,201,JSON.stringify(c.body));
 assert.equal(c.body.data.certification_id,null);assert.ok(c.body.data.description.length>100);
 const password='ValidPassword123!',hashed=await hashPassword(password),sessions=[];
 for(let i=0;i<16;i++){
  const email=`capacity${i}@example.invalid`;
  const id=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
    VALUES('Capacity',$1,$2,$3,'1112223333','1990-01-01','active',true) RETURNING userid`,[String(i),email,hashed])).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='member'",[id]);
  await pool.query(`INSERT INTO user_membership(userid,tierid,startdate,end_date,status) VALUES($1,1,(now()-interval '1 day') AT TIME ZONE 'UTC',(now()+interval '30 days') AT TIME ZONE 'UTC','active')`,[id]);
  const login=await request(server).post('/api/auth/login').send({email,password});assert.equal(login.status,200);sessions.push(login.body.data);
 }
 const paymentsBefore=(await pool.query('SELECT count(*)::int n FROM payment')).rows[0].n;
 const results=await Promise.all(sessions.map(who=>post(`/classes/${c.body.data.id}/enroll`,{},who)));
 assert.ok(results.filter(r=>r.status===200).every(r=>r.body.data.training_fee_cents===0&&r.body.data.payment_id===null));
 assert.equal((await pool.query('SELECT count(*)::int n FROM payment')).rows[0].n,paymentsBefore);
 assert.equal(results.filter(r=>r.status===200).length,15);assert.equal(results.filter(r=>r.status===409).length,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_training_enrollment WHERE class_id=$1',[c.body.data.id])).rows[0].n,15);
 assert.equal((await pool.query('SELECT count(*)::int n FROM user_certifications')).rows[0].n,0);
});
test('migrations alone retire the generic CNC once the named CNCs exist, hiding it from members',async()=>{
 const generic=(await pool.query("SELECT equipmentid AS id,status FROM equipment WHERE name='CNC Machine'")).rows;
 assert.equal(generic.length,1,'migration 021 added the generic CNC');
 assert.equal(generic[0].status,'unavailable');
 assert.equal((await pool.query("SELECT count(*)::int n FROM equipment WHERE name IN ('Joey','Ross','Chandler')")).rows[0].n,3);
 assert.match((await pool.query('SELECT reason FROM app_equipment_retirement WHERE equipment_id=$1',[generic[0].id])).rows[0].reason,/MVP catalog cleanup/);
 const member=(await request(server).post('/api/auth/demo').send({role:'member'})).body.data;
 const list=await request(server).get('/api/equipment').set('Authorization','Bearer '+member.accessToken);
 assert.equal(list.status,200);
 assert.ok(list.body.data.every((r:any)=>r.id!==generic[0].id&&r.name!=='CNC Machine'));
 assert.deepEqual(list.body.data.filter((r:any)=>['Joey','Ross','Chandler'].includes(r.name)).length,3);
 const start=new Date(Math.ceil(Date.now()/3600000)*3600000+86400000);
 const booked=await post('/reservations',{equipmentId:generic[0].id,startTime:start.toISOString(),endTime:new Date(start.getTime()+3600000).toISOString()},member);
 assert.equal(booked.status,404,JSON.stringify(booked.body));assert.equal(booked.body.error.message,'Equipment not found.');
});
test('catalog cleanup is preview-first, idempotent, hides only obsolete entries and preserves records',async()=>{
 const welded=(await pool.query("INSERT INTO equipment(name,status,location) VALUES('Welding Station','available','Fixture') RETURNING equipmentid")).rows[0].equipmentid;
 const cnc=(await pool.query("INSERT INTO equipment(name,status,location) VALUES('CNC Machine','available','Fixture') RETURNING equipmentid")).rows[0].equipmentid;
 const total=(await pool.query('SELECT count(*)::int n FROM equipment')).rows[0].n;
 const courses=(await pool.query('SELECT count(*)::int n FROM certifications')).rows[0].n;
 const legacyRequirements=(await pool.query('SELECT count(*)::int n FROM app_training_requirement')).rows[0].n;
 const before=await configureMvpCatalog(pool);assert.equal(before.applied,false);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_equipment_retirement WHERE equipment_id=ANY($1::int[])',[[welded,cnc]])).rows[0].n,0);
 await assert.rejects(configureMvpCatalog(pool,true,999999),{code:'ADMIN_REQUIRED'});
 await configureMvpCatalog(pool,true,admin.user.id);await configureMvpCatalog(pool,true,admin.user.id);
 assert.equal((await pool.query('SELECT count(*)::int n FROM equipment')).rows[0].n,total);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_equipment_retirement WHERE equipment_id=ANY($1::int[])',[[welded,cnc]])).rows[0].n,2);
 const publicList=await request(server).get('/api/equipment').set('Authorization','Bearer '+admin.accessToken);
 assert.ok(publicList.body.data.every((r:any)=>r.id!==welded&&r.id!==cnc));
 // Migration 032 already linked the machines; apply reuses those courses instead of adding look-alikes.
 assert.deepEqual((await pool.query(`SELECT e.name,c.name AS course FROM equipment e JOIN certifications c USING(certid)
   WHERE e.name=ANY($1::text[]) AND c.training_minutes=60 AND c.training_fee_cents=2000 ORDER BY array_position($1::text[],e.name)`,[['Joey','Ross','Chandler','Kirk','Spock']])).rows,
   [{name:'Joey',course:'CNC'},{name:'Ross',course:'CNC'},{name:'Chandler',course:'CNC'},{name:'Kirk',course:'Metal Lathe'},{name:'Spock',course:'Wood Lathe'}]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM certifications')).rows[0].n,courses,'no duplicate course is created');
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_training_requirement')).rows[0].n,legacyRequirements,'the retired requirement table is never written');
 const configured=await request(server).get('/api/training/catalog').set('Authorization','Bearer '+admin.accessToken);
 assert.ok(configured.body.data.filter((c:any)=>['CNC','Metal Lathe','Wood Lathe'].includes(c.name)).every((c:any)=>c.trainingFeeCents===2000&&c.trainingMinutes===60));
 assert.ok((await pool.query("SELECT validity_days FROM certifications WHERE name IN ('CNC','Metal Lathe','Wood Lathe')")).rows.every(r=>r.validity_days===365),'Annual expiry policy applies to every certification');
});
test('catalog preview reports actual certification pricing; apply only fills an unset fee and audits it',async()=>{
 const ids=Object.fromEntries((await pool.query("SELECT DISTINCT ON(c.name) c.name,c.certid FROM certifications c JOIN equipment e USING(certid) WHERE e.name IN ('Joey','Kirk','Spock') ORDER BY c.name,c.certid")).rows.map(r=>[r.name,r.certid]));
 await pool.query('UPDATE certifications SET training_fee_cents=NULL,training_minutes=90 WHERE certid=$1',[ids['CNC']]);
 await pool.query('UPDATE certifications SET training_fee_cents=3500,training_minutes=45 WHERE certid=$1',[ids['Metal Lathe']]);
 const revision=(await pool.query('SELECT revision FROM certifications WHERE certid=$1',[ids['CNC']])).rows[0].revision;
 const plan=await configureMvpCatalog(pool);assert.equal(plan.applied,false);
 const byName=Object.fromEntries(plan.training.map((t:any)=>[t.name,t]));
 assert.equal(byName['CNC'].certificationId,ids['CNC']);
 assert.deepEqual(byName['CNC'].current,{minutes:90,feeCents:null});
 assert.deepEqual(byName['CNC'].proposed,{minutes:90,feeCents:2000});
 assert.equal(byName['CNC'].action,'set-fee');
 assert.deepEqual(byName['CNC'].link,[],'the preview lists only machines apply will link');
 assert.deepEqual(byName['Metal Lathe'].current,{minutes:45,feeCents:3500});
 assert.deepEqual(byName['Metal Lathe'].proposed,{minutes:45,feeCents:3500});
 assert.equal(byName['Metal Lathe'].action,'none');
 assert.equal((await pool.query('SELECT training_fee_cents FROM certifications WHERE certid=$1',[ids['CNC']])).rows[0].training_fee_cents,null,'preview writes nothing');
 await configureMvpCatalog(pool,true,admin.user.id);await configureMvpCatalog(pool,true,admin.user.id);
 const rows=Object.fromEntries((await pool.query('SELECT certid,training_minutes,training_fee_cents,revision FROM certifications WHERE certid=ANY($1::int[])',[[ids['CNC'],ids['Metal Lathe']]])).rows.map(r=>[r.certid,r]));
 assert.equal(rows[ids['CNC']].training_fee_cents,2000);assert.equal(rows[ids['CNC']].training_minutes,90);
 assert.equal(rows[ids['CNC']].revision,revision+1,'only the first apply changes the fee');
 assert.equal(rows[ids['Metal Lathe']].training_fee_cents,3500);assert.equal(rows[ids['Metal Lathe']].training_minutes,45);
 const audits=(await pool.query("SELECT entity_id,before_state,after_state FROM app_staff_audit WHERE action='certification.training_fee_configured'")).rows;
 assert.equal(audits.length,1);assert.equal(Number(audits[0].entity_id),ids['CNC']);
 assert.deepEqual(audits[0].before_state,{feeCents:null,minutes:90});assert.deepEqual(audits[0].after_state,{feeCents:2000,minutes:90});
});
test('apply merges look-alike courses an earlier run created into the course the machines require',async()=>{
 const cnc=(await pool.query("SELECT certid FROM equipment WHERE name='Joey'")).rows[0].certid;
 const lathe=(await pool.query("SELECT certid FROM equipment WHERE name='Kirk'")).rows[0].certid;
 const generated='One-hour instructor-led safety training. Training fee: $20. Staff must configure the approved certification validity.';
 const course=async(name:string,description:string)=>(await pool.query(`INSERT INTO certifications(certid,name,description,effectivedate,training_fee_cents,training_minutes)
   SELECT COALESCE(MAX(certid),0)+1,$1,$2,NOW() AT TIME ZONE 'UTC',2000,60 FROM certifications RETURNING certid`,[name,description])).rows[0].certid;
 const legacyCnc=await course('CNC Training',generated),legacyLathe=await course('Metal Lathe Training',generated),edited=await course('Wood Lathe Training','Staff-written course');
 for(const id of [legacyCnc,legacyLathe]) await pool.query('INSERT INTO app_training_requirement(certification_id,duration_minutes,fee_cents) VALUES($1,60,2000)',[id]);
 const member=(await request(server).post('/api/auth/demo').send({role:'member'})).body.data.user.id;
 const person=async(name:string)=>(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,dob,status,email_confirmed)
   VALUES('Merge',$1,$2,'unused','1112223333','1990-01-01','active',true) RETURNING userid`,[name,`merge-${name}@example.invalid`])).rows[0].userid;
 // Training and revocation times are days ago.
 const record=async(userId:number,certId:number,trained=0,revoked?:number)=>{
  const id=(await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,trained_at,approved_at,approved_by,verified_in_person,training_minutes)
    SELECT COALESCE(MAX(usercertid),0)+1,$1,$2,'active',NOW()-$4*INTERVAL '1 day',NOW()-$4*INTERVAL '1 day',$3,true,60 FROM user_certifications RETURNING usercertid`,
    [userId,certId,admin.user.id,trained])).rows[0].usercertid;
  if(revoked!==undefined) {
   await pool.query("UPDATE user_certifications SET status='revoked' WHERE usercertid=$1",[id]);
   await pool.query("UPDATE user_certifications SET revoked_at=NOW()-$2*INTERVAL '1 day' WHERE usercertid=$1",[id,revoked]);
  }
  return id;
 };
 // The administrator was trained only under the look-alike. The member's course record is newer
 // than their look-alike one. One person was retrained under the look-alike after the course was
 // revoked, another was trained under it before that revocation, and one person's revocation was
 // recorded only under the look-alike.
 const [retrained,stale,flagged]=[await person('retrained'),await person('stale'),await person('flagged')];
 const trained=await record(admin.user.id,legacyCnc);
 const memberLookAlike=await record(member,legacyCnc,3),memberCourse=await record(member,cnc,1);
 const retrainedCourse=await record(retrained,cnc,30,5),retrainedLookAlike=await record(retrained,legacyCnc,2);
 const staleCourse=await record(stale,cnc,30,5),staleLookAlike=await record(stale,legacyCnc,10);
 const flaggedCourse=await record(flagged,lathe,30),flaggedLookAlike=await record(flagged,legacyLathe,40,3);
 const schedule=(certificationId:number,days:number)=>{
  const start=new Date(Date.now()+days*86400000);
  return post('/classes',{certificationId,title:'CNC safety',instructorId:admin.user.id,roomId:room,capacity:5,
   startsAt:start.toISOString(),endsAt:new Date(start.getTime()+3600000).toISOString(),reason:'Look-alike course class'});
 };
 const scheduled=await schedule(legacyCnc,2);
 assert.equal(scheduled.status,201,JSON.stringify(scheduled.body));
 const plan=await configureMvpCatalog(pool);
 const byName=Object.fromEntries(plan.training.map((t:any)=>[t.name,t]));
 assert.deepEqual(byName['CNC'].duplicates,[{certificationId:legacyCnc,name:'CNC Training',members:4,classes:1,alsoHoldCourse:[
   {userId:member,recordId:memberLookAlike,courseRecordId:memberCourse,outcome:'retire'},
   {userId:retrained,recordId:retrainedLookAlike,courseRecordId:retrainedCourse,outcome:'replace-course-record'},
   {userId:stale,recordId:staleLookAlike,courseRecordId:staleCourse,outcome:'retire'}]}]);
 assert.deepEqual(byName['Metal Lathe'].duplicates,[{certificationId:legacyLathe,name:'Metal Lathe Training',members:1,classes:0,alsoHoldCourse:[
   {userId:flagged,recordId:flaggedLookAlike,courseRecordId:flaggedCourse,outcome:'staff-review'}]}]);
 assert.deepEqual(byName['Wood Lathe'].duplicates,[],'a course staff edited is not a generated duplicate');
 assert.equal((await pool.query('SELECT count(*)::int n FROM user_certifications WHERE certid=$1',[legacyCnc])).rows[0].n,4,'preview writes nothing');
 const lookAlikeTraining=(await pool.query('SELECT trained_at FROM user_certifications WHERE usercertid=$1',[retrainedLookAlike])).rows[0].trained_at;
 await configureMvpCatalog(pool,true,admin.user.id);await configureMvpCatalog(pool,true,admin.user.id);
 assert.equal((await pool.query('SELECT certid FROM user_certifications WHERE usercertid=$1',[trained])).rows[0].certid,cnc,'training under the look-alike now unlocks the CNC machines');
 const held=async(userId:number)=>(await pool.query('SELECT usercertid AS id,certid,status,trained_at,revoked_at FROM user_certifications WHERE userid=$1 ORDER BY usercertid',[userId])).rows;
 assert.deepEqual((await held(member)).map(r=>r.id),[memberCourse],'the older look-alike record is retired');
 const [renewed,...rest]=await held(retrained);
 assert.deepEqual(rest,[]);
 assert.equal(renewed.id,retrainedCourse);assert.equal(renewed.status,'active','retraining after the revocation unlocks the machines again');
 assert.deepEqual(renewed.trained_at,lookAlikeTraining);assert.ok(renewed.revoked_at,'the revocation boundary is kept');
 assert.deepEqual((await held(stale)).map(r=>[r.id,r.status]),[[staleCourse,'revoked']],'training before the revocation does not lift it');
 assert.deepEqual((await held(flagged)).map(r=>[r.id,r.certid,r.status]),[[flaggedCourse,lathe,'active'],[flaggedLookAlike,legacyLathe,'revoked']],
   'a revocation recorded only under the look-alike stays for staff to review');
 assert.equal((await pool.query('SELECT certification_id FROM app_training_class WHERE id=$1',[scheduled.body.data.id])).rows[0].certification_id,cnc);
 assert.deepEqual((await pool.query('SELECT certid,enddate IS NOT NULL AS ended FROM certifications WHERE certid=ANY($1::int[]) ORDER BY certid',[[legacyCnc,legacyLathe,edited]])).rows,
   [{certid:legacyLathe,ended:true},{certid:edited,ended:false}],'a resolved look-alike is removed; one kept for review is ended; a staff-edited course stays');
 assert.equal((await schedule(legacyLathe,3)).body.error.code,'CERTIFICATION_REQUIRED','an ended look-alike is no longer offered for classes');
 assert.equal((await pool.query('SELECT certid FROM equipment WHERE name=$1',['Kirk'])).rows[0].certid,lathe);
 const audited=async(action:string)=>(await pool.query('SELECT subject_id,entity_id FROM app_staff_audit WHERE action=$1 ORDER BY entity_id',[action])).rows
   .map(r=>[r.subject_id,Number(r.entity_id)]);
 assert.deepEqual(await audited('training.course_merged'),[[admin.user.id,trained],[retrained,retrainedCourse]].sort((a,b)=>a[1]!-b[1]!));
 assert.deepEqual(await audited('training.duplicate_retired'),[[member,memberLookAlike],[retrained,retrainedLookAlike],[stale,staleLookAlike]]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_staff_audit WHERE action='certification.duplicate_merged'")).rows[0].n,2,'a repeated apply records nothing new');
 const again:any=(await configureMvpCatalog(pool)).training.find(t=>t.name==='Metal Lathe');
 assert.equal(again.duplicates[0].alsoHoldCourse[0].outcome,'staff-review','the record kept for review is still listed');
});
