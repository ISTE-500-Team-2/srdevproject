import { waiverAcceptance } from '../helpers/waiver.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { evaluateReaderAccess } from '../../src/services/ReaderEligibility.js';
import { AccessService } from '../../src/services/AccessService.js';
import { transaction } from '../../src/db.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database = `arbor_resource_${randomBytes(6).toString('hex')}_mvc_test`;
const admin = new Pool(), pool = new Pool({database});
const secret = randomBytes(32).toString('hex'), uid = '04010203040506';
let app: ReturnType<typeof createApp>, token: string, csrf: string, userId: number;
let staffToken: string, staffCsrf: string;
let room: number, machine: number, otherMachine: number, otherBuilding: number;
let created = false;
before(async () => {
  if (!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Explicit isolated PostgreSQL configuration required.');
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await initializeDemo(pool);
  otherBuilding = (await pool.query("INSERT INTO building(name) VALUES('Other building') RETURNING buildingid")).rows[0].buildingid;
  room = (await pool.query("INSERT INTO room(name,location,status) VALUES('Access room','Test','available') RETURNING roomid")).rows[0].roomid;
  machine = (await pool.query("INSERT INTO equipment(name,status) VALUES('Access machine','available') RETURNING equipmentid")).rows[0].equipmentid;
  otherMachine = (await pool.query("INSERT INTO equipment(name,status) VALUES('Other machine','available') RETURNING equipmentid")).rows[0].equipmentid;
  const hashKey = randomBytes(32).toString('hex');
  app = createApp(pool,{
    jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,
    allowedOrigins:[],timeZone:'America/New_York',devices:{cardHashKey:hashKey,readers:[
      {id:'entrance',secret,kind:'building'},
      {id:'other',secret,kind:'building',resourceId:otherBuilding},
      {id:'machine',secret,kind:'equipment',resourceId:machine},
      {id:'room',secret,kind:'room',resourceId:room},
    ]},
  });
  const login = await request(app).post('/api/auth/demo').send({role:'member'});
  assert.equal(login.status,200);
  token=login.body.data.accessToken; csrf=login.body.data.csrfToken; userId=login.body.data.user.id;
  const staffLogin = await request(app).post('/api/auth/demo').send({role:'admin'});
  assert.equal(staffLogin.status,200);
  staffToken=staffLogin.body.data.accessToken; staffCsrf=staffLogin.body.data.csrfToken;
  for (const w of (await request(app).get('/api/me/waivers').set('Authorization','Bearer '+token)).body.data)
    assert.equal((await post(`/me/waivers/${w.id}/sign`,waiverAcceptance(w))).status,200);
  await pool.query('INSERT INTO app_access_card(user_id,uid_hash,label,assigned_by) VALUES($1,$2,$3,$1)',
    [userId,createHmac('sha256',hashKey).update(uid).digest('hex'),'Access test card']);
});
after(async () => { await pool.end(); if(created) await admin.query(`DROP DATABASE "${database}"`); await admin.end(); });
function post(path: string, body: unknown) {
  return request(app).post('/api'+path).set('Authorization','Bearer '+token).set('X-CSRF-Token',csrf).send(body);
}
function staffPost(path: string, body: unknown = {}) {
  return request(app).post('/api'+path).set('Authorization','Bearer '+staffToken).set('X-CSRF-Token',staffCsrf).send(body);
}
/** Members check in at a reader; the web check-in is staff at the desk, in the member's open account. */
async function deskCheckIn(body: unknown) {
  const opened = await staffPost('/admin/account-mode',{userId});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  staffCsrf = opened.body.data.csrfToken;
  const response = await staffPost('/me/check-ins',body);
  const closed = await staffPost('/admin/account-mode/end');
  assert.equal(closed.status,200,JSON.stringify(closed.body));
  staffCsrf = closed.body.data.csrfToken;
  return response;
}
const refusal = (r: request.Response) => [r.status, r.body.error?.code];
function scan(reader: string, checkIn = false, renewal = false) {
  const body=JSON.stringify({uid,eventId:randomUUID(),checkIn,renewal}), stamp=String(Date.now());
  return request(app).post('/api/devices/decision').set('Content-Type','application/json')
    .set('X-Reader-ID',reader).set('X-Reader-Timestamp',stamp)
    .set('X-Reader-Signature',createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex')).send(body);
}
async function book(key: 'roomid' | 'equipmentid', id: number) {
  return (await pool.query(`INSERT INTO reservation(userid,${key},location,starttime,endtime,status)
    VALUES($1,$2,'Access fixture',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 minutes') AT TIME ZONE 'UTC','confirmed')
    RETURNING reservationid`,[userId,id])).rows[0].reservationid;
}

test('an arrival without an existing visit must choose a building when several exist',async () => {
  const overview = await request(app).get('/api/me/overview').set('Authorization','Bearer '+token);
  assert.equal(overview.body.data.canCheckIn,false);
  assert.equal(overview.body.data.checkInBuildingId,null);
  assert.equal(overview.body.data.buildings.length,2);
  assert.deepEqual(refusal(await deskCheckIn({})),[400,'BUILDING_REQUIRED']);
  for (const id of ['0','bad','1&buildingId=2'])
    assert.equal((await request(app).get('/api/me/overview?buildingId='+id).set('Authorization','Bearer '+token)).status,400);
  const selected = await request(app).get('/api/me/overview?buildingId='+otherBuilding).set('Authorization','Bearer '+token);
  assert.equal(selected.body.data.canCheckIn,true);
  assert.equal(selected.body.data.checkInBuildingId,otherBuilding);
  assert.equal((await deskCheckIn({buildingId:otherBuilding})).status,201);
});

test('portal and readers enforce building assignments, ownership and current confirmed room bookings',async () => {
  const before = (await pool.query('SELECT count(*)::int n FROM check_in WHERE userid=$1',[userId])).rows[0].n;
  const own = await post('/me/check-ins',{location:'Spoofed building'});
  assert.deepEqual(refusal(own),[403,'CHECK_IN_AT_READER']);
  const buildingCheckIn = await deskCheckIn({buildingId:1,location:'Spoofed building'});
  assert.equal(buildingCheckIn.status,201);
  assert.notEqual(buildingCheckIn.body.data.location,'Spoofed building');
  assert.equal((await scan('entrance')).body.data.allowed,true);
  assert.equal((await scan('room')).body.data.reason,'RESERVATION_REQUIRED');
  const booking = await book('roomid',room);
  assert.deepEqual(refusal(await post('/me/check-ins',{roomId:room})),[403,'CHECK_IN_AT_READER'],'a current booking does not open web check-in');
  assert.equal((await pool.query('SELECT count(*)::int n FROM check_in WHERE userid=$1',[userId])).rows[0].n,before+1);
  const desk = await deskCheckIn({roomId:room});
  assert.equal(desk.status,201,JSON.stringify(desk.body));
  assert.equal((await scan('entrance')).body.data.allowed,true);
  assert.equal((await scan('other')).body.data.allowed,true);
  await pool.query('UPDATE room SET buildingid=$2 WHERE roomid=$1',[room,otherBuilding]);
  assert.equal((await scan('entrance')).body.data.allowed,true);
  const allowed = await scan('other',true);
  assert.equal(allowed.body.data.allowed,true);
  const stored = (await pool.query("SELECT buildingid,reservationid FROM check_in WHERE statusdesc='Authenticated NFC eligibility decision' ORDER BY checkinid DESC LIMIT 1")).rows[0];
  assert.equal(stored.buildingid,otherBuilding); assert.equal(stored.reservationid,null);
  await pool.query("UPDATE building SET status='unavailable' WHERE buildingid=$1",[otherBuilding]);
  assert.equal((await scan('room')).body.data.reason,'RESOURCE_UNAVAILABLE');
  assert.deepEqual(refusal(await deskCheckIn({roomId:room})),[403,'RESOURCE_UNAVAILABLE']);
  await pool.query("UPDATE building SET status='available' WHERE buildingid=$1",[otherBuilding]);
  for (const status of ['pending','cancelled']) {
    await pool.query('UPDATE reservation SET status=$2 WHERE reservationid=$1',[booking,status]);
    assert.equal((await scan('other')).body.data.allowed,true);
    assert.deepEqual(refusal(await deskCheckIn({roomId:room})),[403,'RESERVATION_REQUIRED'],status);
  }
  const otherUser = (await pool.query('SELECT userid FROM "user" WHERE userid<>$1 LIMIT 1',[userId])).rows[0].userid;
  await pool.query("UPDATE reservation SET status='confirmed',userid=$2 WHERE reservationid=$1",[booking,otherUser]);
  assert.equal((await scan('room')).body.data.reason,'RESERVATION_REQUIRED');
  await pool.query("UPDATE reservation SET userid=$2,starttime=(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC',endtime=(NOW()+INTERVAL '2 hours') AT TIME ZONE 'UTC' WHERE reservationid=$1",[booking,userId]);
  assert.equal((await scan('room')).body.data.allowed,false);
  await pool.query("UPDATE reservation SET starttime=(NOW()-INTERVAL '2 hours') AT TIME ZONE 'UTC',endtime=NOW() AT TIME ZONE 'UTC' WHERE reservationid=$1",[booking]);
  assert.equal((await scan('room')).body.data.allowed,false);
  assert.deepEqual(refusal(await deskCheckIn({roomId:room,equipmentId:machine})),[400,'INVALID_INPUT']);
});

test('staff overview and unscoped arrival preserve a current second-building visit',async () => {
  assert.equal((await scan('other',true)).body.data.allowed,true);
  await pool.query("UPDATE building SET status='unavailable' WHERE buildingid=1");
  try {
    const overview = await request(app).get('/api/me/overview').set('Authorization','Bearer '+token);
    assert.equal(overview.body.data.checkInBuildingId,otherBuilding);
    assert.equal(overview.body.data.canCheckIn,true);
    assert.equal((await deskCheckIn({})).status,201);
    const visit = (await pool.query('SELECT building_id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[userId])).rows[0];
    assert.equal(visit.building_id,otherBuilding);
    const stored = (await pool.query('SELECT buildingid,roomid,equipmentid,reservationid FROM check_in WHERE userid=$1 ORDER BY checkinid DESC LIMIT 1',[userId])).rows[0];
    assert.deepEqual(stored,{buildingid:otherBuilding,roomid:null,equipmentid:null,reservationid:null});
    assert.deepEqual(refusal(await deskCheckIn({buildingId:1})),[403,'RESOURCE_UNAVAILABLE']);
  } finally {
    await pool.query("UPDATE building SET status='available' WHERE buildingid=1");
  }
});

test('early building tap records presence without unlocking a reserved machine or room',async () => {
  for (const kind of ['room','equipment'] as const) {
    const invalid = await evaluateReaderAccess(pool,'America/New_York',{kind},userId);
    assert.equal(invalid.allowed,false);
    assert.equal(invalid.reason,'RESOURCE_UNAVAILABLE');
  }
  const booking = await book('equipmentid',machine);
  await pool.query("UPDATE reservation SET starttime=(NOW()+INTERVAL '1 hour') AT TIME ZONE 'UTC',endtime=(NOW()+INTERVAL '2 hours') AT TIME ZONE 'UTC' WHERE reservationid=$1",[booking]);
  const overview = await request(app).get('/api/me/overview').set('Authorization','Bearer '+token);
  assert.equal(overview.body.data.canCheckIn,true,JSON.stringify(overview.body));
  const before = (await pool.query('SELECT count(*)::int n FROM check_in WHERE userid=$1',[userId])).rows[0].n;
  const tap = await scan('entrance',true);
  assert.equal(tap.body.data.allowed,true,JSON.stringify(tap.body));
  assert.equal(tap.body.data.reason,'ELIGIBLE');
  assert.equal(tap.body.data.reservationId,null);
  assert.ok(tap.body.data.leaseSeconds>0 && tap.body.data.leaseSeconds<=5);
  const visit = (await pool.query('SELECT building_id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL',[userId])).rows[0];
  assert.equal(visit.building_id,1);
  const stored = (await pool.query('SELECT roomid,equipmentid,reservationid,buildingid FROM check_in WHERE userid=$1 ORDER BY checkinid DESC LIMIT 1',[userId])).rows[0];
  assert.deepEqual(stored,{roomid:null,equipmentid:null,reservationid:null,buildingid:1});
  assert.equal((await scan('entrance',true,true)).body.data.allowed,true);
  for (const reader of ['machine','room']) {
    const denied = await scan(reader,true);
    assert.equal(denied.body.data.allowed,false);
    assert.equal(denied.body.data.reason,'RESERVATION_REQUIRED');
  }
  assert.deepEqual(refusal(await deskCheckIn({equipmentId:machine})),[403,'RESERVATION_REQUIRED']);
  assert.equal((await pool.query('SELECT count(*)::int n FROM check_in WHERE userid=$1',[userId])).rows[0].n,before+1,'renewals and denied resource taps do not record check-ins');
  const start = new Date('2030-01-15T15:00:00.000Z'), end = new Date('2030-01-15T16:00:00.000Z');
  await pool.query(`UPDATE reservation SET starttime=$2::timestamptz AT TIME ZONE 'UTC',endtime=$3::timestamptz AT TIME ZONE 'UTC' WHERE reservationid=$1`,[booking,start,end]);
  // Use a day pass to isolate exact reservation boundaries from membership expiry.
  await pool.query("INSERT INTO day_pass(userid,validdate,status) VALUES($1,'2030-01-15','active')",[userId]);
  const evaluate = (at:Date) => transaction(pool,db=>new AccessService(db,'America/New_York').accessForTarget(userId,{equipmentId:machine},at));
  await assert.rejects(evaluate(new Date(start.getTime()-1)),{code:'RESERVATION_REQUIRED'});
  assert.equal((await evaluate(start)).reservationId,booking);
  assert.equal((await evaluate(new Date(end.getTime()-1))).reservationId,booking);
  await assert.rejects(evaluate(end),{code:'RESERVATION_REQUIRED'});
  await pool.query('DELETE FROM reservation WHERE reservationid=$1',[booking]);
});

test('building entry still enforces facility waivers, account access and building availability',async () => {
  await pool.query("UPDATE building SET status='unavailable' WHERE buildingid=1");
  assert.equal((await scan('entrance',true)).body.data.reason,'RESOURCE_UNAVAILABLE');
  await pool.query("UPDATE building SET status='available' WHERE buildingid=1");
  await pool.query("UPDATE \"user\" SET accessstatus='suspended' WHERE userid=$1",[userId]);
  assert.equal((await scan('entrance',true)).body.data.reason,'ACCOUNT_BLOCKED');
  await pool.query("UPDATE \"user\" SET accessstatus='active' WHERE userid=$1",[userId]);
  await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1',[userId]);
  assert.equal((await scan('entrance',true)).body.data.reason,'WAIVER_REQUIRED');
  assert.deepEqual(refusal(await deskCheckIn({buildingId:1})),[403,'WAIVER_REQUIRED']);
  await pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1',[userId]);
  assert.equal((await scan('entrance',true)).body.data.allowed,true);
  // Restoring access never revives a revoked web session.
  const login = await request(app).post('/api/auth/demo').send({role:'member'});
  assert.equal(login.status,200);
  token=login.body.data.accessToken; csrf=login.body.data.csrfToken;
});

test('equipment checks its own booking and certification and immediately rejects expired access',async () => {
  const booking = await book('equipmentid',machine);
  await pool.query("INSERT INTO certifications(certid,name) VALUES(87001,'Required machine safety'),(87002,'Other safety')");
  await pool.query('UPDATE equipment SET certid=87001 WHERE equipmentid=$1',[machine]);
  await pool.query("INSERT INTO user_certifications(usercertid,userid,certid,status) VALUES(87001,$1,87002,'active')",[userId]);
  assert.equal((await scan('machine')).body.data.reason,'CERTIFICATION_REQUIRED');
  assert.equal((await scan('entrance')).body.data.allowed,true,'equipment training does not grant or block building entry');
  assert.deepEqual(refusal(await deskCheckIn({equipmentId:machine})),[403,'CERTIFICATION_REQUIRED']);
  assert.deepEqual(refusal(await deskCheckIn({equipmentId:otherMachine})),[403,'RESERVATION_REQUIRED']);
  await pool.query("INSERT INTO user_certifications(usercertid,userid,certid,status,renewaldate) VALUES(87002,$1,87001,'active',(NOW()+INTERVAL '1 day') AT TIME ZONE 'UTC')",[userId]);
  assert.deepEqual(refusal(await post('/me/check-ins',{equipmentId:machine})),[403,'CHECK_IN_AT_READER']);
  const allowed = await deskCheckIn({equipmentId:machine});
  assert.equal(allowed.status,201,JSON.stringify(allowed.body));
  const saved = (await pool.query('SELECT equipmentid,reservationid,buildingid FROM check_in WHERE checkinid=$1',[allowed.body.data.id])).rows[0];
  assert.equal(saved.equipmentid,machine); assert.equal(saved.reservationid,booking); assert.equal(saved.buildingid,1);
  assert.equal((await scan('machine')).body.data.allowed,true);
  await pool.query("UPDATE equipment SET status='maintenance' WHERE equipmentid=$1",[machine]);
  assert.equal((await scan('machine')).body.data.reason,'RESOURCE_UNAVAILABLE');
  await pool.query("UPDATE equipment SET status='available' WHERE equipmentid=$1",[machine]);
  await pool.query("UPDATE user_certifications SET renewaldate=(NOW()-INTERVAL '1 second') AT TIME ZONE 'UTC' WHERE usercertid=87002");
  assert.equal((await scan('machine')).body.data.reason,'CERTIFICATION_REQUIRED');
  await pool.query("UPDATE user_membership SET end_date=(NOW()-INTERVAL '1 second') AT TIME ZONE 'UTC' WHERE userid=$1",[userId]);
  assert.equal((await scan('entrance')).body.data.reason,'ENTITLEMENT_REQUIRED');
  assert.deepEqual(refusal(await deskCheckIn({buildingId:1})),[403,'MEMBERSHIP_REQUIRED']);
  await pool.query("UPDATE \"user\" SET status='inactive' WHERE userid=$1",[userId]);
  assert.equal((await scan('entrance')).body.data.reason,'ACCOUNT_BLOCKED');
  assert.equal((await post('/me/check-ins',{})).status,401);
  const refused = await staffPost('/admin/account-mode',{userId});
  assert.deepEqual([refused.status,refused.body.error.code],[403,'ACCOUNT_MODE_REFUSED'],'staff cannot open an inactive account to check it in');
  await pool.query("UPDATE \"user\" SET status='active' WHERE userid=$1",[userId]);
  assert.equal((await post('/me/check-ins',{})).status,401,'Restoring the account never revives the old JWT');
});
