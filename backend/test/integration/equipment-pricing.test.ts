import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { waiverAcceptance } from '../helpers/waiver.js';

const database = `arbor_equipment_price_${randomBytes(5).toString('hex')}_mvc_test`;
const owner = new Pool({idleTimeoutMillis:1000}), pool = new Pool({database,idleTimeoutMillis:1000});
let server: Server, created=false, admin:any, member:any, machine:any, course:any, first:any, second:any;
const start = new Date(Date.now()+3*86400000); start.setUTCHours(16,0,0,0);
const slot = (days=0,hours=2) => ({equipmentId:machine.equipmentid,startTime:new Date(+start+days*86400000).toISOString(),endTime:new Date(+start+days*86400000+hours*3600000).toISOString()});
const get = (path:string, actor=member) => request(server).get('/api'+path).set('Authorization','Bearer '+actor.accessToken);
const post = (path:string,body:object={},actor=member) => request(server).post('/api'+path).set('Authorization','Bearer '+actor.accessToken).set('X-CSRF-Token',actor.csrfToken).send(body);
const patch = (path:string,body:object) => request(server).patch('/api'+path).set('Authorization','Bearer '+admin.accessToken).set('X-CSRF-Token',admin.csrfToken).send(body);
const quote = async(hours=2) => (await get(`/equipment/${machine.equipmentid}/quote?hours=${hours}`)).body.data;

before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  const app=createApp(pool,{jwtKey:randomBytes(32),host:'127.0.0.1',port:8080,secureCookies:false,demoLogin:true,allowedOrigins:[],timeZone:'America/New_York'});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  admin=(await request(server).post('/api/auth/demo').send({role:'admin'})).body.data;
  member=(await request(server).post('/api/auth/demo').send({role:'member'})).body.data;
  for(const w of (await get('/me/waivers')).body.data)assert.equal((await post(`/me/waivers/${w.id}/sign`,waiverAcceptance(w))).status,200);
  machine=(await pool.query("SELECT * FROM equipment WHERE name='Joey'")).rows[0];
  course=(await get('/training/catalog',admin)).body.data.find((c:any)=>c.id===machine.certid);
});
after(async()=>{
  if(server)await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});
  await pool.end();try{if(created)await owner.query(`DROP DATABASE "${database}"`);}finally{await owner.end();}
});

test('approved courses are linked to CNC and lathes, with one-hour training and a $20 booking fee',async()=>{
  const courses=(await get('/training/catalog',admin)).body.data;
  for(const name of ['CNC','Metal Lathe','Wood Lathe']){
    const c=courses.find((c:any)=>c.name===name);assert.ok(c);assert.equal(c.trainingMinutes,60);assert.equal(c.trainingFeeCents,2000);assert.ok(c.equipmentIds.length);
  }
  assert.equal((await pool.query("SELECT certid FROM equipment WHERE name='Rachel'")).rows[0].certid,null);
  const price=await quote();assert.equal(price.equipmentCents,5600);assert.equal(price.trainingFeeCents,2000);assert.equal(price.totalCents,7600);
  assert.equal((await get(`/equipment/${machine.equipmentid}/quote?hours=0`)).status,400);
});
test('training still gates booking; instructor approval supports an explicitly indefinite certification',async()=>{
  const denied=await post('/reservations',{...slot(),expectedPrice:await quote()});assert.equal(denied.status,403);assert.equal(denied.body.error.code,'CERTIFICATION_REQUIRED');
  const evidence={
    trainedAt:new Date(Date.now()-3600000).toISOString(),source:'equipment',verifiedInPerson:true,verificationReference:'Observed one-hour CNC training',reason:'Synthetic completed training'
  };
  assert.equal((await post(`/training/users/${member.user.id}/certifications/${course.id}`,{...evidence,trainingMinutes:59},admin)).status,400);
  const approval=await post(`/training/users/${member.user.id}/certifications/${course.id}`,{...evidence,trainingMinutes:60},admin);
  assert.equal(approval.status,201,JSON.stringify(approval.body));assert.equal(approval.body.data.valid,true);assert.equal(approval.body.data.expiresAt,null);
  assert.equal(approval.body.data.trainingMinutes,60);
});
test('missing or altered quotes cannot create charges; certified users pay the fee on every booking',async()=>{
  const before=(await pool.query('SELECT count(*) FROM payment')).rows[0].count;
  assert.equal((await post('/reservations',slot())).status,409);
  const price=await quote();assert.equal((await post('/reservations',{...slot(),expectedPrice:{...price,trainingFeeCents:0,totalCents:5600}})).status,409);
  assert.equal((await pool.query('SELECT count(*) FROM payment')).rows[0].count,before);
  const a=await post('/reservations',{...slot(),expectedPrice:price});assert.equal(a.status,201,JSON.stringify(a.body));first=a.body.data;
  assert.deepEqual(first.priceSnapshot,price);assert.equal(first.paymentStatus,'pending');
  assert.equal((await pool.query('SELECT price FROM payment WHERE paymentid=$1',[first.paymentId])).rows[0].price,'76.00');
  const b=await post('/reservations',{...slot(1,1),expectedPrice:await quote(1)});assert.equal(b.status,201,JSON.stringify(b.body));second=b.body.data;
  assert.equal(second.priceSnapshot.totalCents,4800);assert.equal(second.priceSnapshot.trainingFeeCents,2000);
});
test('fee configuration validates bounds and stale revisions; price changes do not rewrite booked amounts',async()=>{
  const path=`/training/catalog/${course.id}`, body={name:course.name,description:course.description,validityDays:null,equipmentIds:course.equipmentIds,expectedRevision:course.revision,trainingMinutes:60,trainingFeeCents:2500,reason:'Synthetic price change'};
  for(const fee of [-1,1.5,'2000'])assert.equal((await patch(path,{...body,trainingFeeCents:fee})).status,400);
  const old=await quote();assert.equal((await patch(path,body)).status,200);assert.equal((await patch(path,body)).status,409);
  const stale=await post('/reservations',{...slot(2),expectedPrice:old});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'PRICE_CHANGED');
  const saved=(await get('/reservations')).body.data.find((r:any)=>r.id===first.id);assert.equal(saved.priceSnapshot.totalCents,7600);
  assert.equal((await quote()).totalCents,8100);
});
test('editing an unpaid booking updates its one invoice and preserves the previous state in audit',async()=>{
  const response=await patch(`/admin/reservations/${first.id}`,{...slot(0,1),expectedRevision:first.revision,expectedPrice:await quote(1)});
  assert.equal(response.status,200,JSON.stringify(response.body));first=response.body.data;
  assert.equal(first.paymentId!==null,true);assert.equal(first.priceSnapshot.totalCents,5300);
  const p=(await pool.query('SELECT price,revision FROM payment WHERE paymentid=$1',[first.paymentId])).rows[0];assert.equal(p.price,'53.00');
  const audit=(await pool.query("SELECT before_state,after_state FROM app_staff_audit WHERE action='reservation.override.updated' AND entity_id=$1 ORDER BY id DESC LIMIT 1",[first.id])).rows[0];
  assert.equal(audit.before_state.priceSnapshot.totalCents,7600);assert.equal(audit.after_state.priceSnapshot.totalCents,5300);
  assert.equal((await post(`/admin/payments/${first.paymentId}/status`,{status:'paid',method:'cash',reference:'LOCAL-TEST',reason:'Synthetic payment received',revision:p.revision},admin)).status,200);
  const denied=await patch(`/admin/reservations/${first.id}`,{...slot(0,2),expectedRevision:first.revision,expectedPrice:await quote(2)});
  assert.equal(denied.status,409);assert.equal(denied.body.error.code,'PAYMENT_SETTLED');
  assert.equal((await pool.query('SELECT price FROM payment WHERE paymentid=$1',[first.paymentId])).rows[0].price,'53.00');
});
test('cancellation voids unpaid amounts, while paid bookings stay visible for an explicit refund',async()=>{
  assert.equal((await post(`/reservations/${second.id}/cancel`)).status,200);
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[second.paymentId])).rows[0].paymentstatus,'void');
  assert.equal((await post(`/admin/reservations/${first.id}/cancel`,{},admin)).status,200);
  const payment=(await get('/admin/payments',admin)).body.data.items.find((p:any)=>p.id===first.paymentId);
  assert.equal(payment.status,'paid');assert.match(payment.planName,/refund due/);
});
test('class creation enforces 15 people and a full hour of training',async()=>{
  const instructor=(await pool.query(`INSERT INTO "user"(firstname,lastname,email,password,phone,status) VALUES('Synthetic','Instructor','training-instructor@example.invalid','unused','0000000000','active') RETURNING userid`)).rows[0].userid;
  await pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor'",[instructor]);
  const room=(await pool.query("SELECT roomid FROM room WHERE name='Training Room'")).rows[0].roomid;
  const body={title:'CNC test class',certificationId:course.id,instructorId:instructor,roomId:room,capacity:16,startsAt:slot(3,1).startTime,endsAt:slot(3,1).endTime,reason:'Synthetic class policy fixture'};
  assert.equal((await post('/classes',body,admin)).status,400);
  const short=await post('/classes',{...body,capacity:15,endsAt:new Date(Date.parse(body.startsAt)+30*60000).toISOString()},admin);
  assert.equal(short.status,400);assert.equal(short.body.error.code,'TRAINING_DURATION');
  const response=await post('/classes',{...body,capacity:15},admin);assert.equal(response.status,201,JSON.stringify(response.body));
  await assert.rejects(pool.query('UPDATE app_training_class SET capacity=16 WHERE id=$1',[response.body.data.id]),{code:'23514'});
});

test('rescheduling a waived booking keeps the waiver; a newly priced booking gets a fresh payment',async()=>{
  const a=await post('/reservations',{...slot(6,1),expectedPrice:await quote(1)});assert.equal(a.status,201,JSON.stringify(a.body));
  const booking=a.body.data, payment=(await pool.query('SELECT revision FROM payment WHERE paymentid=$1',[booking.paymentId])).rows[0];
  assert.equal((await post(`/admin/payments/${booking.paymentId}/status`,{status:'waived',method:'unspecified',reference:'',reason:'Approved synthetic waiver',revision:payment.revision},admin)).status,200);
  const moved=await patch(`/admin/reservations/${booking.id}`,{...slot(7,1),expectedPrice:await quote(1),expectedRevision:booking.revision});
  assert.equal(moved.status,200,JSON.stringify(moved.body));assert.equal(moved.body.data.paymentId,booking.paymentId);assert.equal(moved.body.data.paymentStatus,'waived');
  const changed=await patch(`/admin/reservations/${booking.id}`,{...slot(7,2),expectedPrice:await quote(2),expectedRevision:moved.body.data.revision});
  assert.equal(changed.status,200,JSON.stringify(changed.body));assert.notEqual(changed.body.data.paymentId,booking.paymentId);assert.equal(changed.body.data.paymentStatus,'pending');
  assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[booking.paymentId])).rows[0].paymentstatus,'waived');
});
