import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {repositoryRoot} from '../../src/scripts/migrate.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_signed_copy_mvc_test';
const adminPool=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let app:ReturnType<typeof createApp>;
let member:{id:number;token:string;csrf:string};
async function login(role:string){const r=await request(app).post('/api/auth/demo').send({role});assert.equal(r.status,200);return {id:r.body.data.user.id,token:r.body.data.accessToken,csrf:r.body.data.csrfToken};}
function get(url:string){return request(app).get('/api'+url).set('Authorization','Bearer '+member.token);}
function post(url:string,body:object){return request(app).post('/api'+url).set('Authorization','Bearer '+member.token).set('X-CSRF-Token',member.csrf).send(body);}
async function sign(name:string,text:string) {
  const waiverId=(await pool.query(`INSERT INTO waiver(name,version,description,effectivedate) VALUES($1,'v1',$2,NOW() AT TIME ZONE 'UTC') RETURNING waiverid`,[name,text])).rows[0].waiverid;
  assert.equal((await post(`/me/waivers/${waiverId}/sign`,{accepted:true})).status,200);
  return (await pool.query('SELECT userwaiverid FROM user_waiver WHERE userid=$1 AND waiverid=$2',[member.id,waiverId])).rows[0].userwaiverid as number;
}
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
  await adminPool.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
  member=await login('member');
});
after(async()=>{await pool.end();if(created)await adminPool.query(`DROP DATABASE "${database}"`);await adminPool.end();});

test('signing stores the same signed copy outside the notification queue',async()=>{
  const id=await sign('Durable Copy Policy','Durable accepted wording.');
  const copy=(await pool.query('SELECT userid,payload FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id])).rows[0];
  const notice=(await pool.query("SELECT payload FROM app_notification_outbox WHERE dedupe_key=$1 AND kind='waiver_signed'",[`waiver-signed:${id}`])).rows[0];
  assert.equal(copy.userid,member.id);
  assert.deepEqual(copy.payload,notice.payload);
  assert.equal(copy.payload.waiverText,'Durable accepted wording.');
});

test('signed copy is still listed and downloadable after its notification row is deleted',async()=>{
  const id=await sign('Outbox Cleanup Policy','Wording that must outlive email cleanup.');
  await pool.query('DELETE FROM app_notification_outbox WHERE dedupe_key=$1',[`waiver-signed:${id}`]);
  await pool.query("UPDATE waiver SET description='Changed later' WHERE waiverid=(SELECT waiverid FROM user_waiver WHERE userwaiverid=$1)",[id]);
  const listed=(await get('/me/signed-waivers')).body.data.find((w:{id:number})=>w.id===id);
  assert.equal(listed.copyAvailable,true);assert.equal(listed.name,'Outbox Cleanup Policy');
  const copy=await get(`/me/signed-waivers/${id}/copy`);
  assert.equal(copy.status,200);
  assert.match(copy.body.data.content,/Wording that must outlive email cleanup\./);
  assert.doesNotMatch(copy.body.data.content,/Changed later/);
});

test('signatures without a stored copy still fall back to the notification row',async()=>{
  const id=await sign('Legacy Fallback Policy','Legacy queued wording.');
  await pool.query('DELETE FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id]);
  const listed=(await get('/me/signed-waivers')).body.data.find((w:{id:number})=>w.id===id);
  assert.equal(listed.copyAvailable,true);
  const copy=await get(`/me/signed-waivers/${id}/copy`);
  assert.equal(copy.status,200);assert.match(copy.body.data.content,/Legacy queued wording\./);
});

test('migration backfills missing copies from the queue, idempotently and only for the owner',async()=>{
  const id=await sign('Backfill Policy','Backfilled wording.');
  const other=await sign('Untouched Policy','Already copied wording.');
  await pool.query('DELETE FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id]);
  await pool.query("UPDATE app_signed_waiver_copy SET payload=payload||'{\"marker\":true}' WHERE userwaiverid=$1",[other]);
  // A queue row claiming the signature for another account is never copied.
  const stranger=(await pool.query('SELECT userid FROM "user" WHERE userid<>$1 ORDER BY userid LIMIT 1',[member.id])).rows[0].userid;
  await pool.query("UPDATE app_notification_outbox SET userid=$1 WHERE dedupe_key=$2",[stranger,`waiver-signed:${id}`]);
  const sql=await readFile(path.join(repositoryRoot,'database/migrations/039_signed_waiver_copy.sql'),'utf8');
  await pool.query(sql);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id])).rows[0].n,0);
  await pool.query("UPDATE app_notification_outbox SET userid=$1 WHERE dedupe_key=$2",[member.id,`waiver-signed:${id}`]);
  await pool.query(sql);await pool.query(sql);
  const restored=(await pool.query('SELECT userid,payload FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id])).rows[0];
  assert.equal(restored.userid,member.id);assert.equal(restored.payload.waiverText,'Backfilled wording.');
  assert.equal((await pool.query('SELECT payload FROM app_signed_waiver_copy WHERE userwaiverid=$1',[other])).rows[0].payload.marker,true);
});

test('deleting a signature removes its stored copy',async()=>{
  const id=await sign('Cascade Policy','Cascade wording.');
  await pool.query('DELETE FROM user_waiver WHERE userwaiverid=$1',[id]);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_signed_waiver_copy WHERE userwaiverid=$1',[id])).rows[0].n,0);
});
