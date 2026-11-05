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
 const before=await configureMvpCatalog(pool);assert.equal(before.applied,false);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_equipment_retirement WHERE equipment_id=ANY($1::int[])',[[welded,cnc]])).rows[0].n,0);
 await assert.rejects(configureMvpCatalog(pool,true,999999),{code:'ADMIN_REQUIRED'});
 await configureMvpCatalog(pool,true,admin.user.id);await configureMvpCatalog(pool,true,admin.user.id);
 assert.equal((await pool.query('SELECT count(*)::int n FROM equipment')).rows[0].n,total);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_equipment_retirement WHERE equipment_id=ANY($1::int[])',[[welded,cnc]])).rows[0].n,2);
 const publicList=await request(server).get('/api/equipment').set('Authorization','Bearer '+admin.accessToken);
 assert.ok(publicList.body.data.every((r:any)=>r.id!==welded&&r.id!==cnc));
 assert.equal((await pool.query("SELECT count(*)::int n FROM equipment WHERE name=ANY($1::text[]) AND certid IS NOT NULL",[['Joey','Ross','Chandler','Kirk','Spock']])).rows[0].n,5);
 assert.equal((await pool.query('SELECT count(*)::int n FROM app_training_requirement WHERE duration_minutes=60 AND fee_cents=2000')).rows[0].n,3);
 const configured=await request(server).get('/api/training/catalog').set('Authorization','Bearer '+admin.accessToken);
 assert.ok(configured.body.data.filter((c:any)=>['CNC Training','Metal Lathe Training','Wood Lathe Training'].includes(c.name)).every((c:any)=>c.trainingFeeCents===2000&&c.trainingMinutes===60));
 assert.ok((await pool.query("SELECT validity_days FROM certifications WHERE name IN ('CNC Training','Metal Lathe Training','Wood Lathe Training')")).rows.every(r=>r.validity_days===null),'No expiry policy was invented');
});
