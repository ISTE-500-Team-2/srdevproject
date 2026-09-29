import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {updateNotificationPreferences} from '../../src/notifications/store.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_waiver_mvc_test';
const adminPool=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let app:ReturnType<typeof createApp>;
let member:{id:number;token:string;csrf:string};let administrator:typeof member;let policyId:number;let signatureId:number;
async function login(role:string){const r=await request(app).post('/api/auth/demo').send({role});assert.equal(r.status,200);return {id:r.body.data.user.id,token:r.body.data.accessToken,csrf:r.body.data.csrfToken};}
function get(path:string,actor=member){return request(app).get('/api'+path).set('Authorization','Bearer '+actor.token);}
function post(path:string,body:unknown,actor=member){return request(app).post('/api'+path).set('Authorization','Bearer '+actor.token).set('X-CSRF-Token',actor.csrf).send(body);}
function patch(path:string,body:unknown,actor=administrator){return request(app).patch('/api'+path).set('Authorization','Bearer '+actor.token).set('X-CSRF-Token',actor.csrf).send(body);}
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
 await adminPool.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
 member=await login('member');administrator=await login('admin');
 policyId=(await pool.query(`INSERT INTO waiver(name,version,description,effectivedate) VALUES('Signed Copy Test','v1','Original accepted wording, retained forever.',NOW() AT TIME ZONE 'UTC') RETURNING waiverid`)).rows[0].waiverid;
});
after(async()=>{await pool.end();if(created)await adminPool.query(`DROP DATABASE "${database}"`);await adminPool.end();});
test('signed copy remains available with notification opt-out and preserves original wording',async()=>{
 await updateNotificationPreferences(pool,member.id,{enabled:false,timeZone:'America/New_York'});
 assert.equal((await post(`/me/waivers/${policyId}/sign`,{accepted:true})).status,200);
 const records=await get('/me/signed-waivers');assert.equal(records.status,200);
 const signed=records.body.data.find((w:any)=>w.waiverId===policyId);signatureId=signed.id;assert.equal(signed.copyAvailable,true);
 assert.equal((await pool.query("SELECT status FROM app_notification_outbox WHERE dedupe_key=$1",[`waiver-signed:${signatureId}`])).rows[0].status,'suppressed');
 await pool.query("UPDATE waiver SET description='Changed current policy text' WHERE waiverid=$1",[policyId]);
 const copy=await get(`/me/signed-waivers/${signatureId}/copy`);assert.equal(copy.status,200);
 assert.match(copy.body.data.content,/Original accepted wording/);assert.doesNotMatch(copy.body.data.content,/Changed current/);
 const other=await get(`/me/signed-waivers/${signatureId}/copy`,administrator);assert.equal(other.status,404);
 const authorized=await get(`/admin/users/${member.id}/signed-waivers/${signatureId}/copy`,administrator);assert.equal(authorized.status,200);
});
test('legacy signatures truthfully report unavailable copies',async()=>{
 const legacy=(await pool.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval) VALUES($1,$2,NOW() AT TIME ZONE 'UTC',false) RETURNING userwaiverid`,[member.id,policyId])).rows[0].userwaiverid;
 const copy=await get(`/me/signed-waivers/${legacy}/copy`);assert.equal(copy.status,409);assert.equal(copy.body.error.code,'SIGNED_COPY_UNAVAILABLE');
});
test('only admin can set expiry with reason, CSRF and optimistic concurrency; edit is audited',async()=>{
 const path=`/admin/users/${member.id}/signed-waivers/${signatureId}/expiry`;
 const expiry=new Date(Date.now()+20*86400000).toISOString();
 const body={expiresAt:expiry,expectedExpiry:null,reason:'Approved policy expiration date'};
 assert.equal((await patch(path,body,member)).status,403);
 assert.equal((await request(app).patch('/api'+path).set('Authorization','Bearer '+administrator.token).send(body)).status,403);
 assert.equal((await patch(path,{...body,reason:''})).status,400);
 assert.equal((await patch(path,body)).status,200);
 assert.equal((await patch(path,{...body,expiresAt:new Date(Date.now()+21*86400000).toISOString()})).status,409);
 const audit=(await pool.query("SELECT actor_id,before_state,after_state FROM app_staff_audit WHERE action='waiver_expiry_updated' AND entity_id=$1",[signatureId])).rows[0];
 assert.equal(audit.actor_id,administrator.id);assert.equal(audit.before_state.expiresAt,null);assert.equal(audit.after_state.expiresAt,expiry);
 assert.equal((await patch(path,{expiresAt:null,expectedExpiry:expiry,reason:'Expiration withdrawn by sponsor'})).status,200);
 assert.equal((await pool.query('SELECT expires_at FROM user_waiver WHERE userwaiverid=$1',[signatureId])).rows[0].expires_at,null);
});
test('expired agreements no longer satisfy access and can be re-signed without destroying historical copy',async()=>{
 await pool.query("UPDATE user_waiver SET signdate=(NOW()-INTERVAL '2 days') AT TIME ZONE 'UTC' WHERE userwaiverid=$1",[signatureId]);
 const expiry=new Date(Date.now()-86400000).toISOString();
 assert.equal((await patch(`/admin/users/${member.id}/signed-waivers/${signatureId}/expiry`,{expiresAt:expiry,expectedExpiry:null,reason:'Recorded actual expired agreement'})).status,200);
 const waivers=await get('/me/waivers');assert.equal(waivers.body.data.find((w:any)=>w.id===policyId).signed,false);
 assert.equal((await post(`/me/waivers/${policyId}/sign`,{accepted:true})).status,200);
 const rows=(await pool.query('SELECT userwaiverid,approval FROM user_waiver WHERE userid=$1 AND waiverid=$2 ORDER BY userwaiverid',[member.id,policyId])).rows;
 assert.equal(rows.find(r=>r.userwaiverid===signatureId).approval,false);assert.equal(rows.filter(r=>r.approval).length,1);
 assert.equal((await get(`/me/signed-waivers/${signatureId}/copy`)).status,200);
});
test('restoring an explicit expiration revives its canceled reminder without duplicate rows',async()=>{
 await updateNotificationPreferences(pool,member.id,{enabled:true,timeZone:'America/New_York'});
 const active=(await pool.query('SELECT userwaiverid FROM user_waiver WHERE userid=$1 AND waiverid=$2 AND approval=true',[member.id,policyId])).rows[0].userwaiverid;
 const path=`/admin/users/${member.id}/signed-waivers/${active}/expiry`;
 const expiry=new Date(Date.now()+25*86400000).toISOString();
 for(const [expiresAt,expectedExpiry] of [[expiry,null],[null,expiry],[expiry,null]])
   assert.equal((await patch(path,{expiresAt,expectedExpiry,reason:'Sponsor corrected explicit expiry'})).status,200);
 const rows=(await pool.query("SELECT status,counts_for_sla FROM app_notification_outbox WHERE dedupe_key=$1",[`waiver-expiring:${active}:${expiry}`])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(rows[0].counts_for_sla,true);
});
