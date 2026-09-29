import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {enqueueNotification,notificationMetrics,updateNotificationPreferences} from '../../src/notifications/store.js';
import {runNotificationBatch,NotificationSendError} from '../../src/notifications/worker.js';
import {scheduleExpirationNotifications} from '../../src/notifications/scheduler.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_notification_mvc_test';
const admin=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let userId:number;
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
  await admin.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  userId=(await pool.query('SELECT userid FROM "user" ORDER BY userid LIMIT 1')).rows[0].userid;
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();});
async function reset() {await pool.query('DELETE FROM app_notification_outbox');await updateNotificationPreferences(pool,userId,{enabled:true,timeZone:'America/New_York'});}
async function enqueue(key:string,options:Partial<Parameters<typeof enqueueNotification>[1]>={}) {await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:key,payload:{},...options});}
test('durable dedupe and concurrent workers send one event once',async()=>{
 await reset();await Promise.all([enqueue('same'),enqueue('same')]);let count=0;
 const send=async()=>{count++;return {messageId:'unique'};};
 await Promise.all([runNotificationBatch(pool,send),runNotificationBatch(pool,send)]);
 assert.equal(count,1);assert.equal((await pool.query('SELECT status FROM app_notification_outbox')).rows[0].status,'accepted');
});
test('all-event opt-out suppresses queued and newly enqueued events',async()=>{
 await reset();await enqueue('before');await updateNotificationPreferences(pool,userId,{enabled:false,timeZone:'Europe/Zagreb'});await enqueue('after');
 await runNotificationBatch(pool,async()=>{throw new Error('must not send');});
 assert.equal((await pool.query("SELECT COUNT(*)::int n FROM app_notification_outbox WHERE status='suppressed'")).rows[0].n,2);
});
test('known rejections retry boundedly; ambiguous timeout is not replayed',async()=>{
 await reset();await enqueue('retry');const now=new Date(Date.now()+1000);
 const reject=async()=>{throw new NotificationSendError('no quota',{retryable:true});};
 assert.equal((await runNotificationBatch(pool,reject,{now,maxAttempts:2})).retried,1);
 assert.equal((await runNotificationBatch(pool,reject,{now:new Date(now.getTime()+31000),maxAttempts:2})).failed,1);
 await enqueue('timeout');assert.equal((await runNotificationBatch(pool,async()=>{throw new Error('timeout');},{now:new Date(now.getTime()+32000)})).uncertain,1);
 let count=0;await runNotificationBatch(pool,async()=>{count++;return {messageId:'no'};},{now:new Date(now.getTime()+1e7)});assert.equal(count,0);
});
test('expired lease uncertain; late/failed events remain in metric denominator',async()=>{
 await reset();await enqueue('crash',{deadlineAt:new Date(Date.now()-1000)});
 await pool.query("UPDATE app_notification_outbox SET status='sending',lease_until=NOW()-INTERVAL '1 minute'");await runNotificationBatch(pool,async()=>{throw new Error('must not resend');});
 const metric=await notificationMetrics(pool);assert.equal(metric.uncertain,1);assert.equal(metric.eligible,1);assert.equal(metric.onTimePercent,0);
});
test('scheduler deduplicates and cancels stale renewed certifications',async()=>{
 await reset();const now=new Date();const expiry=new Date(now.getTime()+4*86400000);
 await pool.query(`INSERT INTO certifications(certid,name) VALUES(90001,'Notification test')`);
 await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status) VALUES(90001,$1,90001,$2::timestamptz AT TIME ZONE 'UTC','active')`,[userId,expiry]);
 await scheduleExpirationNotifications(pool,now);await scheduleExpirationNotifications(pool,now);
 assert.equal((await pool.query("SELECT COUNT(*)::int n FROM app_notification_outbox WHERE dedupe_key LIKE 'certification-expiring:90001:%'")).rows[0].n,1);
 await pool.query("UPDATE user_certifications SET renewaldate=renewaldate+INTERVAL '1 year' WHERE usercertid=90001");
 await runNotificationBatch(pool,async row=>{assert.notEqual(row.payload.sourceId,90001);return {messageId:`other-${row.id}`};},{now:new Date(now.getTime()+1000)});
 assert.equal((await pool.query("SELECT status FROM app_notification_outbox WHERE dedupe_key LIKE 'certification-expiring:90001:%'")).rows[0].status,'obsolete');
});
test('timezone change reschedules pending reminder but never revives suppressed mail',async()=>{
  await reset();const expiry=new Date('2030-03-12T20:00:00Z');
  await enqueue('tz',{kind:'waiver_expiring',dueAt:new Date('2030-03-04T14:00:00Z'),deadlineAt:new Date('2030-03-05T20:00:00Z'),payload:{sourceType:'waiver',sourceId:999,expiresAt:expiry.toISOString()}});
  await updateNotificationPreferences(pool,userId,{enabled:true,timeZone:'Asia/Tokyo'});
  assert.equal((await pool.query("SELECT due_at FROM app_notification_outbox WHERE dedupe_key='tz'")).rows[0].due_at.toISOString(),'2030-03-05T00:00:00.000Z');
  await updateNotificationPreferences(pool,userId,{enabled:false,timeZone:'Asia/Tokyo'});
  await updateNotificationPreferences(pool,userId,{enabled:true,timeZone:'America/New_York'});
  assert.equal((await pool.query("SELECT status FROM app_notification_outbox WHERE dedupe_key='tz'")).rows[0].status,'suppressed');
});
test('unchanged expired source is failed and remains in on-time metric denominator',async()=>{
  await reset();const expiry=new Date(Date.now()-10000);
  await pool.query(`UPDATE user_certifications SET renewaldate=$1::timestamptz AT TIME ZONE 'UTC' WHERE usercertid=90001`,[expiry]);
  await enqueue('expired',{kind:'certification_expiring',deadlineAt:new Date(expiry.getTime()-7*86400000),payload:{sourceType:'certification',sourceId:90001,expiresAt:expiry.toISOString()}});
  const result=await runNotificationBatch(pool,async()=>{throw new Error('expired mail must not send');});
  assert.equal(result.failed,1);const metric=await notificationMetrics(pool);assert.equal(metric.eligible,1);assert.equal(metric.onTimePercent,0);
});
test('explicit provider retry-after delays retries and suppression after deadline cannot erase a miss',async()=>{
  await reset();const now=new Date(Date.now()+1000);await enqueue('quota',{deadlineAt:new Date(Date.now()-1000)});
  await runNotificationBatch(pool,async()=>{throw new NotificationSendError('quota',{retryable:true,retryAfterMs:120000});},{now});
  const row=(await pool.query("SELECT due_at FROM app_notification_outbox WHERE dedupe_key='quota'")).rows[0];
  assert.equal(row.due_at.getTime(),now.getTime()+120000);
  await updateNotificationPreferences(pool,userId,{enabled:false,timeZone:'America/New_York'});
  const metric=await notificationMetrics(pool);assert.equal(metric.eligible,1);assert.equal(metric.onTimePercent,0);
});
test('PostgreSQL sub-millisecond expirations still match queued JavaScript dates',async()=>{
  await reset();
  await pool.query("UPDATE user_certifications SET renewaldate=TIMESTAMP '2030-05-20 12:00:00.123456' WHERE usercertid=90001");
  const now=new Date('2030-05-15T12:00:00Z');await scheduleExpirationNotifications(pool,now);
  let sent=false;await runNotificationBatch(pool,async row=>{if(row.payload.sourceId===90001)sent=true;return {messageId:`micro-${row.id}`};},{now});
  assert.equal(sent,true);
});
