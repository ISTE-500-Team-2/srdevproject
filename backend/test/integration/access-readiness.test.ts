import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import type {AppConfig} from '../../src/config.js';
const database=`arbor_readiness_${randomBytes(6).toString('hex')}_mvc_test`;
const admin=new Pool(),pool=new Pool({database});
const secret=randomBytes(32).toString('hex'),hashKey=randomBytes(32).toString('hex'),uid='0405060708090A',cert=887001;
let app:ReturnType<typeof createApp>,config:AppConfig,token:string,memberToken:string,userId:number,machine:number,room:number,created=false;
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
 await admin.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 await pool.query("INSERT INTO certifications(certid,name) VALUES($1,'Readiness safety')",[cert]);
 machine=(await pool.query("INSERT INTO equipment(name,status,certid) VALUES('Readiness printer','available',$1) RETURNING equipmentid",[cert])).rows[0].equipmentid;
 room=(await pool.query("INSERT INTO room(name,location,status) VALUES('Readiness room','Test','available') RETURNING roomid")).rows[0].roomid;
 config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:[],timeZone:'America/New_York',devices:{cardHashKey:hashKey,readers:[{id:'printer',secret,kind:'equipment',resourceId:machine},{id:'room',secret,kind:'room',resourceId:room},{id:'entrance',secret,kind:'building'}]}};
 app=createApp(pool,config);
 token=(await request(app).post('/api/auth/demo').send({role:'admin'})).body.data.accessToken;
 const member=await request(app).post('/api/auth/demo').send({role:'member'});memberToken=member.body.data.accessToken;userId=member.body.data.user.id;
 await pool.query("INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,'Readiness card',$1)",[userId,createHmac('sha256',hashKey).update(uid).digest('hex')]);
 await pool.query("INSERT INTO user_waiver(userid,waiverid,signdate,approval) SELECT $1,waiverid,NOW() AT TIME ZONE 'UTC',true FROM waiver WHERE isactive AND required",[userId]);
 await pool.query("INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate) VALUES(887001,$1,$2,'active',(NOW()+INTERVAL '1 year') AT TIME ZONE 'UTC')",[userId,cert]);
 for(const [key,id]of [['equipmentid',machine],['roomid',room]]as const)await pool.query(`INSERT INTO reservation(userid,${key},location,starttime,endtime,status) VALUES($1,$2,'Readiness fixture',(NOW()-INTERVAL '1 hour') AT TIME ZONE 'UTC',(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC','confirmed')`,[userId,id]);
});
beforeEach(async()=>{
 if(!created||!userId)return;
 await pool.query("UPDATE \"user\" SET status='active',accessstatus='active' WHERE userid=$1",[userId]);
 await pool.query("UPDATE user_membership SET status='active',startdate=(NOW()-INTERVAL '1 day') AT TIME ZONE 'UTC',end_date=(NOW()+INTERVAL '1 day') AT TIME ZONE 'UTC' WHERE userid=$1",[userId]);
 await pool.query("UPDATE day_pass SET status='suspended' WHERE userid=$1",[userId]);
 await pool.query('UPDATE user_waiver SET approval=true,expires_at=NULL WHERE userid=$1',[userId]);
 await pool.query("UPDATE user_certifications SET status='active',renewaldate=(NOW()+INTERVAL '1 year') AT TIME ZONE 'UTC' WHERE userid=$1 AND certid=$2",[userId,cert]);
 await pool.query("UPDATE equipment SET status='available' WHERE equipmentid=$1",[machine]);
 await pool.query("UPDATE reservation SET status='confirmed',starttime=(NOW()-INTERVAL '1 hour') AT TIME ZONE 'UTC',endtime=(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC' WHERE userid=$1 AND (equipmentid=$2 OR roomid=$3)",[userId,machine,room]);
 await pool.query('UPDATE app_access_card SET active=true WHERE user_id=$1',[userId]);
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();});
function preview(reader='printer',target=userId,auth=token,instance=app){return request(instance).get(`/api/admin/users/${target}/access-readiness?readerId=${reader}`).set('Authorization','Bearer '+auth);}
function scan(reader='printer'){const body=JSON.stringify({uid,eventId:randomUUID(),checkIn:false}),stamp=String(Date.now());return request(app).post('/api/devices/decision').set('Content-Type','application/json').set('X-Reader-ID',reader).set('X-Reader-Timestamp',stamp).set('X-Reader-Signature',createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex')).send(body);}
async function state(){const result:Record<string,string>={};for(const table of ['user','app_access_card','user_membership','user_waiver','user_certifications','reservation','app_device_access_event','check_in','app_staff_audit'])result[table]=(await pool.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${table}" t`)).rows[0].hash;return result;}
async function parity(reason:string,reader='printer'){
 const before=await state(),p=await preview(reader);assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.headers['cache-control'],'no-store');assert.deepEqual(await state(),before,'preview must not write grants, visits, events or audits');
 const real=await scan(reader);assert.equal(real.status,200,JSON.stringify(real.body));assert.equal(p.body.data.reason,reason);assert.equal(p.body.data.allowed,real.body.data.allowed);assert.equal(p.body.data.reason,real.body.data.reason);
 for(const key of ['member','leaseSeconds','decisionId','eventId','uid','uidHash','secret','cardHashKey'])assert.equal(key in p.body.data,false,key);return p.body.data;
}
test('preview requires authenticated staff with global user-read permission',async()=>{
 assert.equal((await request(app).get(`/api/admin/users/${userId}/access-readiness`)).status,401);
 assert.equal((await preview('printer',userId,memberToken)).status,403);
 assert.equal((await preview('printer',userId+99999)).status,404);assert.equal((await preview('printer',-1)).status,400);
 assert.equal((await preview('unknown')).status,404);assert.equal((await preview('printer&readerId=room')).status,400);
});
test('configured targets expose names but no reader/card credentials; absent configuration stays unavailable',async()=>{
 const p=await request(app).get(`/api/admin/users/${userId}/access-readiness`).set('Authorization','Bearer '+token);assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.data.readerId,'printer');assert.equal(p.body.data.readers.length,3);assert.equal(p.body.data.readers[0].name,'Readiness printer');
 for(const r of p.body.data.readers)assert.deepEqual(Object.keys(r).sort(),['id','kind','name','resourceId']);
 assert.equal(JSON.stringify(p.body).includes(secret),false);assert.equal(JSON.stringify(p.body).includes(hashKey),false);
 assert.equal((await preview('printer',userId,token,createApp(pool,{...config,devices:undefined}))).status,503);
});
test('ready preview matches signed Pi decision without events, check-ins or usable commands',async()=>{const d=await parity('ELIGIBLE');assert.equal(d.allowed,true);assert.equal(d.cardAssigned,true);assert.ok(Date.parse(d.expiresAt)>Date.parse(d.checkedAt));assert.ok(Date.parse(d.expiresAt)-Date.parse(d.checkedAt)<=5000);assert.equal((await parity('ELIGIBLE','room')).allowed,true);});
test('revoked cards are blocked just like a physical revoked-card scan',async()=>{await pool.query('UPDATE app_access_card SET active=false WHERE user_id=$1',[userId]);assert.equal((await parity('CARD_NOT_ASSIGNED')).cardAssigned,false);});
test('staff suspension and inactive account match physical decisions',async()=>{await pool.query("UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1",[userId]);await parity('ACCOUNT_BLOCKED');await pool.query("UPDATE \"user\" SET accessstatus='active',status='inactive' WHERE userid=$1",[userId]);await parity('ACCOUNT_BLOCKED');});
test('active account without membership stays blocked; current day pass follows shared rule',async()=>{await pool.query("UPDATE user_membership SET status='suspended' WHERE userid=$1",[userId]);await parity('ENTITLEMENT_REQUIRED');await pool.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,(NOW() AT TIME ZONE 'America/New_York')::date,'active')",[userId]);await parity('ELIGIBLE');});
test('missing and expired waivers use same denial as reader',async()=>{await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1',[userId]);await parity('WAIVER_REQUIRED');await pool.query("UPDATE user_waiver SET approval=true,expires_at=NOW()-INTERVAL '1 second' WHERE userid=$1",[userId]);await parity('WAIVER_REQUIRED');});
test('training, booking and resource decisions are target-specific and never cached',async()=>{
 await pool.query("UPDATE user_certifications SET status='revoked' WHERE userid=$1 AND certid=$2",[userId,cert]);await parity('CERTIFICATION_REQUIRED');await parity('ELIGIBLE','room');
 await pool.query("UPDATE user_certifications SET status='active' WHERE userid=$1 AND certid=$2",[userId,cert]);await pool.query("UPDATE reservation SET status='cancelled' WHERE userid=$1 AND equipmentid=$2",[userId,machine]);await parity('RESERVATION_REQUIRED');await pool.query("UPDATE equipment SET status='maintenance' WHERE equipmentid=$1",[machine]);await parity('RESOURCE_UNAVAILABLE');
});
test('verification contention returns unavailable, not fabricated approval',async()=>{const blocker=await pool.connect();try{await blocker.query('BEGIN');await blocker.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[userId]);const r=await preview();assert.equal(r.status,503,JSON.stringify(r.body));assert.equal(r.body.error.code,'READINESS_UNAVAILABLE');assert.equal(r.body.data,undefined);}finally{await blocker.query('ROLLBACK');blocker.release();}});
