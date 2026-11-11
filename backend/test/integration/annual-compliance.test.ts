import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_annual_mvc_test';
const adminPool=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let app:ReturnType<typeof createApp>;
let member:{id:number;token:string;csrf:string};let administrator:typeof member;let policyId:number;
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

test('annual defaults, duplicate signing, expiration and re-signing preserve signed copies',async()=>{
 const signed=await post(`/me/waivers/${policyId}/sign`,{accepted:true});
 assert.equal(signed.status,200);
 let rows=(await pool.query(`SELECT userwaiverid,expires_at,signdate AT TIME ZONE 'UTC' AS signed FROM user_waiver WHERE userid=$1 AND waiverid=$2`,[member.id,policyId])).rows;
 const original=rows[0];
 assert.equal(original.expires_at.getTime()-original.signed.getTime(),365*86400000);
 assert.equal((await post(`/me/waivers/${policyId}/sign`,{accepted:true})).status,200);
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM user_waiver WHERE userid=$1 AND waiverid=$2',[member.id,policyId])).rows[0].n,1);
 await pool.query("UPDATE user_waiver SET signdate=(NOW()-INTERVAL '366 days') AT TIME ZONE 'UTC',expires_at=NOW()-INTERVAL '1 day' WHERE userwaiverid=$1",[original.userwaiverid]);
 const current=(await get('/me/waivers')).body.data.find((w:any)=>w.id===policyId);
 assert.equal(current.signed,false);assert.equal(current.expiredSignature,true);
 assert.equal((await post(`/me/waivers/${policyId}/sign`,{accepted:true})).status,200);
 rows=(await pool.query('SELECT userwaiverid,approval,expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 ORDER BY userwaiverid',[member.id,policyId])).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].approval,false);assert.equal(rows[1].approval,true);
 assert.ok(rows[1].expires_at>new Date(Date.now()+364*86400000));
 assert.equal((await get(`/me/signed-waivers/${original.userwaiverid}/copy`)).status,200);
});

test('publication and certification issuance use annual validity even with legacy no-expiry input',async()=>{
 const published=await post('/admin/policies',{name:'Annual published',version:'v1',description:'Annual agreement wording.',effectiveAt:new Date(Date.now()-60000).toISOString(),approvalReference:'Punchlist',reason:'Annual compliance',validityDays:null},administrator);
 assert.equal(published.status,201,JSON.stringify(published.body));assert.equal(published.body.data.validityDays,365);
 const course=await post('/training/catalog',{name:'Annual safety',description:'In-person safety',validityDays:null,equipmentIds:[],reason:'Annual compliance'},administrator);
 assert.equal(course.status,201,JSON.stringify(course.body));assert.equal(course.body.data.validityDays,365);
 const trained=new Date(Date.now()-86400000);
 const grant=await post(`/training/users/${member.id}/certifications/${course.body.data.id}`,{trainedAt:trained.toISOString(),source:'equipment',verifiedInPerson:true,verificationReference:'Observed demonstration',reason:'Training completed'},administrator);
 assert.equal(grant.status,201,JSON.stringify(grant.body));
 const expiry=(await pool.query(`SELECT renewaldate AT TIME ZONE 'UTC' AS expires FROM user_certifications WHERE userid=$1 AND certid=$2`,[member.id,course.body.data.id])).rows[0].expires;
 assert.equal(expiry.getTime()-trained.getTime(),365*86400000);
});

test('upgrade dates legacy signatures from signing and preserves shorter deadlines',async()=>{
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  await db.query('ALTER TABLE waiver DROP CONSTRAINT waiver_annual_validity');
  await db.query('ALTER TABLE certifications DROP CONSTRAINT certification_annual_validity');
  await db.query('ALTER TABLE waiver ALTER COLUMN validity_days DROP NOT NULL');
  await db.query('ALTER TABLE certifications ALTER COLUMN validity_days DROP NOT NULL');
  await db.query('UPDATE waiver SET validity_days=NULL');
  await db.query('UPDATE certifications SET validity_days=NULL');
  const legacy=(await db.query(`INSERT INTO user_waiver(userid,waiverid,signdate,approval) VALUES($1,$2,(NOW()-INTERVAL '400 days') AT TIME ZONE 'UTC',false) RETURNING userwaiverid`,[member.id,policyId])).rows[0].userwaiverid;
  const legacyCert=(await db.query("INSERT INTO certifications(certid,name) SELECT COALESCE(MAX(certid),0)+1,'Legacy annual safety' FROM certifications RETURNING certid")).rows[0].certid;
  const legacyGrant=(await db.query(`INSERT INTO user_certifications(usercertid,userid,certid,status,trained_at)
    SELECT COALESCE(MAX(usercertid),0)+1,$1,$2,'active',NOW()-INTERVAL '400 days' FROM user_certifications RETURNING usercertid`,[member.id,legacyCert])).rows[0].usercertid;
  const old=(await db.query('SELECT expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 AND approval=true',[member.id,policyId])).rows[0].expires_at;
  await db.query(await readFile(new URL('../../../database/migrations/038_annual_compliance.sql',import.meta.url),'utf8'));
  const row=(await db.query(`SELECT expires_at,signdate AT TIME ZONE 'UTC' AS signed FROM user_waiver WHERE userwaiverid=$1`,[legacy])).rows[0];
  assert.equal(row.expires_at.getTime()-row.signed.getTime(),365*86400000);assert.ok(row.expires_at<new Date());
  assert.equal((await db.query('SELECT expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 AND approval=true',[member.id,policyId])).rows[0].expires_at.getTime(),old.getTime());
  const training=(await db.query(`SELECT renewaldate AT TIME ZONE 'UTC' AS expires,trained_at FROM user_certifications WHERE usercertid=$1`,[legacyGrant])).rows[0];
  assert.equal(training.expires.getTime()-training.trained_at.getTime(),365*86400000);assert.ok(training.expires<new Date());
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM certifications WHERE validity_days IS DISTINCT FROM 365')).rows[0].n,0);
 } finally {await db.query('ROLLBACK');db.release();}
});

test('administrative expiry cannot extend a signature beyond its annual deadline',async()=>{
 const row=(await pool.query('SELECT userwaiverid,expires_at FROM user_waiver WHERE userid=$1 AND waiverid=$2 AND approval=true',[member.id,policyId])).rows[0];
 const response=await patch(`/admin/users/${member.id}/signed-waivers/${row.userwaiverid}/expiry`,{expiresAt:new Date(Date.now()+400*86400000).toISOString(),expectedExpiry:row.expires_at.toISOString(),reason:'Attempt to extend deadline'});
 assert.equal(response.status,400);assert.equal(response.body.error.code,'INVALID_EXPIRY');
});
