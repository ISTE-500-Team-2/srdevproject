/** Real HTTP gateway + application + disposable PostgreSQL. No provider calls,
 * hardware, live accounts, production config or migrations are changed here.
 */
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {confirmationToken} from '../helpers/confirmation.js';
import {createEdge} from '../../../deploy/rles-edge.mjs';

const database='arbor_unified_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const secret=randomBytes(32).toString('hex'),uid='04A1B2C3D4E5F6';
const readerId='arbor-pi-01-test';
let created=false,appServer:any,edge:any,base:string;
let staff:any,member:any,csrf:string,memberCsrf:string,userId:number,cardId:number,roomId:number;
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  roomId=(await pool.query("INSERT INTO room(name,location,status) VALUES('Unified test room','Fixture','available') RETURNING roomid")).rows[0].roomid;
  const app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,
    demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York',
    devices:{cardHashKey:randomBytes(32).toString('hex'),readers:[{id:readerId,secret,kind:'room',resourceId:roomId}]}});
  appServer=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>appServer.once('listening',resolve));
  edge=createEdge({digest:createHash('sha256').update('fixture').digest('hex'),allowedPeers:['127.0.0.1'],
    stateFile:'unused',applicationPort:appServer.address().port});
  edge.listen(0,'127.0.0.1');await new Promise<void>(resolve=>edge.once('listening',resolve));
  base=`http://127.0.0.1:${edge.address().port}`;
  staff=request.agent(base);member=request.agent(base);
  const login=await staff.post('/api/auth/demo').send({role:'admin'});
  assert.equal(login.status,200);csrf=login.body.data.csrfToken;
  staff.set('Authorization','Bearer '+login.body.data.accessToken);
});
after(async()=>{
  for(const server of [edge,appServer]) if(server) await new Promise<void>(resolve=>{server.close(resolve);server.closeAllConnections();});
  await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();
});
const post=(path:string,body:unknown)=>staff.post('/api'+path).set('X-CSRF-Token',csrf).send(body);
const memberPost=(path:string,body:unknown)=>member.post('/api'+path).set('X-CSRF-Token',memberCsrf).send(body);
function scan(checkIn=false,key=secret) {
  const body=JSON.stringify({uid,eventId:randomUUID(),checkIn}),stamp=String(Date.now());
  return request(base).post('/api/devices/decision').set('Content-Type','application/json')
    .set('X-Reader-ID',readerId).set('X-Reader-Timestamp',stamp)
    .set('X-Reader-Signature',createHmac('sha256',key).update(stamp+'\n'+body).digest('hex')).send(body);
}
test('new website identity is immediately available to staff/card assignment through the same gateway',async()=>{
  const email='unified@example.invalid';
  const signup=await member.post('/api/auth/register').send({email,username:'unified_fixture',password:'GoodPassword123!',
    firstName:'Unified',lastName:'Fixture',dob:'2000-01-01',phone:'0000000000'});
  assert.equal(signup.status,202,JSON.stringify(signup.body));
  const confirmed=await member.post('/api/auth/confirm').send({token:await confirmationToken(pool,email)});
  assert.equal(confirmed.status,200);memberCsrf=confirmed.body.data.csrfToken;userId=confirmed.body.data.user.id;
  member.set('Authorization','Bearer '+confirmed.body.data.accessToken);
  const users=await staff.get('/api/admin/users').query({search:email});
  assert.equal(users.body.data.items.find((u:any)=>u.id===userId).email,email);
  assert.equal((await scan()).body.data.reason,'CARD_NOT_ASSIGNED');
  const card=await post('/admin/access/cards',{userId,uid,label:'Verified fixture card',reason:'Confirmed fixture identity'});
  assert.equal(card.status,201,JSON.stringify(card.body));cardId=card.body.data.id;
  const denied=await scan(true);
  assert.equal(denied.body.data.allowed,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM check_in WHERE userid=$1',[userId])).rows[0].n,0);
});
test('staff-recorded payment, signed waivers and reservation produce a linked NFC check-in visible in staff portal',async()=>{
  const plans=await staff.get('/api/admin/plans');
  const plan=plans.body.data.find((p:any)=>p.kind==='membership' && p.active);
  assert.ok(plan);
  const issued=await post(`/admin/users/${userId}/entitlements`,{requestId:randomUUID(),planId:plan.id,
    startsAt:new Date(Date.now()-60000).toISOString(),paymentStatus:'paid',method:'cash',
    reference:'isolated-fixture',reason:'Fixture payment recorded, no money moved'});
  assert.equal(issued.status,201,JSON.stringify(issued.body));
  const payments=await member.get('/api/me/payments');
  assert.ok(payments.body.data.items.some((p:any)=>p.reference==='isolated-fixture'));
  for(const waiver of (await member.get('/api/me/waivers')).body.data)
    assert.equal((await memberPost(`/me/waivers/${waiver.id}/sign`,{accepted:true})).status,200);
  assert.equal((await scan()).body.data.reason,'RESERVATION_REQUIRED');
  // Only the active booking clock is a SQL fixture; all identity/payment/card/waiver operations above use APIs.
  const reservation=(await pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    VALUES($1,$2,'Fixture',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',
    (NOW()+INTERVAL '30 minutes') AT TIME ZONE 'UTC','confirmed') RETURNING reservationid`,[userId,roomId])).rows[0];
  const allowed=await scan(true);
  assert.equal(allowed.status,200,JSON.stringify(allowed.body));
  assert.equal(allowed.body.data.allowed,true);assert.equal(allowed.body.data.member.id,userId);
  const portal=await staff.get(`/api/admin/users/${userId}`);
  assert.equal(portal.body.data.checkIns.length,1);
  const stored=(await pool.query('SELECT userid,reservationid,roomid FROM check_in WHERE userid=$1',[userId])).rows[0];
  assert.equal(stored.userid,userId);assert.equal(stored.reservationid,reservation.reservationid);assert.equal(stored.roomid,roomId);
  const copies=await member.get('/api/me/signed-waivers');
  assert.ok(copies.body.data.length>0);
  assert.ok(copies.body.data.every((w:any)=>w.copyAvailable));
});
test('signature failure and staff card revocation fail closed without new check-ins; audit survives',async()=>{
  assert.equal((await scan(true,'wrong-secret')).status,401);
  const revoked=await post(`/admin/access/cards/${cardId}/revoke`,{expectedRevision:1,reason:'Fixture revocation'});
  assert.equal(revoked.status,200,JSON.stringify(revoked.body));
  assert.equal((await scan(true)).body.data.reason,'CARD_NOT_ASSIGNED');
  const portal=await staff.get(`/api/admin/users/${userId}`);
  assert.equal(portal.body.data.checkIns.length,1);
  const audit=await pool.query("SELECT action FROM app_staff_audit WHERE subject_id=$1 AND action IN ('access.card_assigned','access.card_revoked')",[userId]);
  assert.equal(audit.rowCount,2);
});
