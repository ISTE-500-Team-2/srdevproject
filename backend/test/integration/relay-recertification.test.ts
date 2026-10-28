import { waiverAcceptance } from '../helpers/waiver.js';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';

const database=`arbor_relay_${randomBytes(6).toString('hex')}_mvc_test`;
const admin=new Pool(),pool=new Pool({database});
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
  await admin.query(`CREATE DATABASE "${database}"`);await initializeDemo(pool);
});
after(async()=>{await pool.end();await admin.query(`DROP DATABASE "${database}"`);await admin.end();});

test('real signed API grants stop after an incident and require newly verified training, not account restoration',async()=>{
  const secret=randomBytes(32).toString('hex'),hashKey=randomBytes(32).toString('hex'),uid='04020304050607';
  const cert=900001;
  await pool.query("INSERT INTO certifications(certid,name,validity_days) VALUES($1,'Relay safety',365)",[cert]);
  const machine=(await pool.query("INSERT INTO equipment(name,status,certid) VALUES('Relay fixture','available',$1) RETURNING equipmentid",[cert])).rows[0].equipmentid;
  const app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,
    demoLogin:true,allowedOrigins:[],timeZone:'America/New_York',devices:{cardHashKey:hashKey,readers:[{id:'relay-fixture',secret,kind:'equipment',resourceId:machine}]}});
  const member=request.agent(app),staff=request.agent(app);
  const ml=(await member.post('/api/auth/demo').send({role:'member'})).body.data;
  const sl=(await staff.post('/api/auth/demo').send({role:'admin'})).body.data;
  member.set('Authorization','Bearer '+ml.accessToken);staff.set('Authorization','Bearer '+sl.accessToken);
  const post=(path:string,body:unknown)=>staff.post('/api'+path).set('X-CSRF-Token',sl.csrfToken).send(body);
  for(const waiver of (await member.get('/api/me/waivers')).body.data)
    assert.equal((await member.post(`/api/me/waivers/${waiver.id}/sign`).set('X-CSRF-Token',ml.csrfToken).send(waiverAcceptance(waiver))).status,200);
  await pool.query('INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,\'Relay test\',$3)',[ml.user.id,createHmac('sha256',hashKey).update(uid).digest('hex'),sl.user.id]);
  await pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
    VALUES($1,$2,'Relay fixture',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 minutes') AT TIME ZONE 'UTC','confirmed')`,[ml.user.id,machine]);
  const trainedAt=new Date(Date.now()-3600000).toISOString();
  const approval={trainedAt,verifiedInPerson:true,source:'equipment',verificationReference:'Synthetic instructor check',reason:'Test training'};
  const path=`/training/users/${ml.user.id}/certifications/${cert}`;
  let response=await post(path,approval);assert.equal(response.status,201,JSON.stringify(response.body));
  async function scan(checkIn=false){
    const body=JSON.stringify({uid,eventId:randomUUID(),checkIn}),stamp=String(Date.now());
    const result=await request(app).post('/api/devices/decision').set('Content-Type','application/json')
      .set('X-Reader-ID','relay-fixture').set('X-Reader-Timestamp',stamp)
      .set('X-Reader-Signature',createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex')).send(body);
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;
  }
  const initial=await scan(true);assert.equal(initial.allowed,true);assert.ok(initial.leaseSeconds>0&&initial.leaseSeconds<=5);
  assert.equal((await scan()).allowed,true);
  response=await post(path+'/revoke',{expectedRevision:response.body.data.revision,reason:'Synthetic safety incident'});
  assert.equal(response.status,200,JSON.stringify(response.body));
  const revision=response.body.data.revision;
  const listed=await staff.get(`/api/training/users/${ml.user.id}`);
  assert.ok(listed.body.data.find((r:any)=>r.certificationId===cert).revokedAt);
  const denied=await scan();assert.equal(denied.reason,'CERTIFICATION_REQUIRED');assert.equal(denied.leaseSeconds,0);assert.equal(denied.expiresAt,null);
  await pool.query("UPDATE \"user\" SET accessstatus='active' WHERE userid=$1",[ml.user.id]);
  assert.equal((await scan()).allowed,false);
  response=await post(path,{...approval,expectedRevision:revision});
  assert.equal(response.status,409);assert.equal(response.body.error.code,'RETRAINING_REQUIRED');
  response=await post(path,{...approval,trainedAt:new Date().toISOString(),expectedRevision:revision,verifiedInPerson:false});
  assert.equal(response.status,400);assert.equal((await scan()).allowed,false);
  response=await post(path,{...approval,trainedAt:new Date().toISOString(),expectedRevision:revision});
  assert.equal(response.status,201,JSON.stringify(response.body));
  assert.equal((await scan()).allowed,true);
  const visits=(await pool.query('SELECT count(*)::int AS n FROM check_in WHERE userid=$1',[ml.user.id])).rows[0].n;
  assert.equal(visits,1,'Renewals and denied decisions never create duplicate visits');
  const audit=(await pool.query("SELECT action FROM app_staff_audit WHERE subject_id=$1 AND action IN ('training.revoked','training.renewed')",[ml.user.id])).rows;
  assert.ok(audit.some(x=>x.action==='training.revoked'));assert.ok(audit.some(x=>x.action==='training.renewed'));
});

test('upgrade preserves revoked records and their audit boundary, with a conservative legacy fallback',async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DROP TRIGGER app_mark_training_revocation ON user_certifications');
    await db.query('DROP FUNCTION app_mark_training_revocation()');
    await db.query('ALTER TABLE user_certifications DROP COLUMN revoked_at');
    const user=(await db.query('SELECT userid FROM "user" ORDER BY userid LIMIT 1')).rows[0].userid;
    await db.query("INSERT INTO certifications(certid,name) VALUES(900002,'Legacy audited'),(900003,'Legacy unknown')");
    await db.query("INSERT INTO user_certifications(usercertid,userid,certid,status) VALUES(900002,$1,900002,'revoked'),(900003,$1,900003,'revoked')",[user]);
    await db.query(`INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason,created_at)
      VALUES($1,$1,'training.revoked','user_certification',900002,'Synthetic legacy incident','2026-01-01T00:00:00Z')`,[user]);
    const migration=await readFile(new URL('../../../database/migrations/020_recertification_after_revocation.sql',import.meta.url),'utf8');
    await db.query(migration);
    const records=(await db.query('SELECT certid,status,revoked_at,revoked_at=transaction_timestamp() AS fallback FROM user_certifications WHERE certid IN (900002,900003) ORDER BY certid')).rows;
    assert.equal(records[0].status,'revoked');assert.equal(records[0].revoked_at.toISOString(),'2026-01-01T00:00:00.000Z');
    assert.equal(records[1].status,'revoked');assert.equal(records[1].fallback,true);
    await db.query("UPDATE user_certifications SET status='revoked' WHERE certid=900002");
    const latest=(await db.query('SELECT revoked_at FROM user_certifications WHERE certid=900002')).rows[0].revoked_at;
    assert.ok(latest>records[0].revoked_at,'Direct database revocation records the new incident boundary');
  } finally {await db.query('ROLLBACK');db.release();}
});
