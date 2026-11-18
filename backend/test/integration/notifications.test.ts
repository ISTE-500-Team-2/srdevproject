import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {enqueueNotification,enqueueNotifications,notificationMetrics,updateNotificationPreferences} from '../../src/notifications/store.js';
import {drainNotificationBatches,runNotificationBatch,NotificationSendError} from '../../src/notifications/worker.js';
import {previousNotificationCandidate} from '../helpers/previousNotificationClaim.js';
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
/** Upserts certification 90001 and the user's record of it, so each test that reads it also runs alone. */
async function ensureCertification(renewal:Date) {
  await pool.query(`INSERT INTO certifications(certid,name) VALUES(90001,'Notification test') ON CONFLICT (certid) DO NOTHING`);
  await pool.query(`INSERT INTO user_certifications(usercertid,userid,certid,renewaldate,status) VALUES(90001,$1,90001,$2::timestamptz AT TIME ZONE 'UTC','active')
    ON CONFLICT (usercertid) DO UPDATE SET userid=EXCLUDED.userid,certid=EXCLUDED.certid,renewaldate=EXCLUDED.renewaldate,status=EXCLUDED.status`,[userId,renewal]);
}
async function enqueue(key:string,options:Partial<Parameters<typeof enqueueNotification>[1]>={}) {await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:key,payload:{},...options});}
test('durable dedupe and concurrent workers send one event once',async()=>{
 await reset();await Promise.all([enqueue('same'),enqueue('same')]);let count=0;
 const send=async()=>{count++;return {messageId:'unique'};};
 await Promise.all([runNotificationBatch(pool,send),runNotificationBatch(pool,send)]);
 assert.equal(count,1);assert.equal((await pool.query('SELECT status FROM app_notification_outbox')).rows[0].status,'accepted');
});
test('the previous worker skips all new kinds and the current worker sends them',async()=>{
  await reset();
  const kinds = [
    'account_exists',
    'membership_cancellation_confirmed',
    'reservation_cancelled_by_staff',
    'admin_studio_reservation_confirmed',
    'admin_studio_reservation_cancelled',
  ] as const;
  // Give the new notices earlier due times, so each would outrank the compatible job.
  const dueAt = new Date(Date.now()-60_000);
  for (const kind of kinds)
    await enqueueNotification(pool,{userId,kind,dedupeKey:kind,payload:{},dueAt});
  await enqueue('compatible');
  const now = new Date();
  assert.equal(await previousNotificationCandidate(pool,now),'account_created');
  assert.equal((await notificationMetrics(pool)).pending,kinds.length+1);

  const sent: string[] = [];
  const result = await runNotificationBatch(pool,async row=>{
    sent.push(row.kind);
    return {messageId:row.dedupeKey};
  },{now});
  assert.equal(result.accepted,kinds.length+1);
  assert.deepEqual(sent,[...kinds,'account_created']);
});

test('a deferred or retried new kind stays hidden from the previous worker',async()=>{
  await reset();
  await enqueueNotification(pool,{userId,kind:'reservation_cancelled_by_staff',dedupeKey:'cutover-retry',payload:{}});
  const now = new Date();
  const deferred = await runNotificationBatch(pool,async()=>{
    throw new NotificationSendError('account refused',{retryable:false,account:true});
  },{now});
  assert.equal(deferred.deferred,1);
  assert.equal(await previousNotificationCandidate(pool,now),undefined);

  const retried = await runNotificationBatch(pool,async()=>{
    throw new NotificationSendError('rate limited',{retryable:true});
  },{now});
  assert.equal(retried.retried,1);
  const next = new Date(now.getTime()+31_000);
  assert.equal(await previousNotificationCandidate(pool,next),undefined);
  const accepted = await runNotificationBatch(pool,async row=>({messageId:row.dedupeKey}),{now:next});
  assert.equal(accepted.accepted,1);
});
test('all-event opt-out suppresses queued and newly enqueued events',async()=>{
 await reset();await enqueue('before');await enqueue('before-v2',{kind:'reservation_cancelled_by_staff'});
 await updateNotificationPreferences(pool,userId,{enabled:false,timeZone:'Europe/Zagreb'});await enqueue('after');
 // The opt-out updates both queue states immediately, even if no worker is running yet.
 assert.equal((await pool.query("SELECT COUNT(*)::int n FROM app_notification_outbox WHERE status='suppressed'")).rows[0].n,3);
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
test('an announcement to everyone queues once per account and gives way to one person\'s mail queued after it',async()=>{
 await reset();
 const everyone=(await pool.query(`SELECT userid FROM "user" WHERE status='active' ORDER BY userid`)).rows.map(r=>r.userid as number);
 // Still sending after its hour: the deadline has passed, and one person's mail still goes first.
 const announce=()=>enqueueNotifications(pool,everyone,{kind:'system_issue',dedupePrefix:'notice:1:',payload:{reason:'Shop closed',broadcast:true},
  dueAt:new Date(Date.now()-3_700_000),deadlineAt:new Date(Date.now()-100_000)});
 await announce();await announce();
 const queued=(await pool.query("SELECT userid,dedupe_key FROM app_notification_outbox WHERE kind='system_issue' ORDER BY userid")).rows;
 assert.deepEqual(queued.map(r=>r.userid),everyone);
 assert.ok(queued.every(r=>r.dedupe_key===`notice:1:${r.userid}`));
 await enqueue('personal');
 // A reader alert to a few staff is not a broadcast, so it goes ahead too.
 await enqueueNotifications(pool,[userId],{kind:'system_issue',dedupePrefix:'reader-alert:',payload:{reason:'Reader offline',readerId:'r1'}});
 const sent:string[]=[];
 await runNotificationBatch(pool,async row=>{sent.push(row.dedupeKey);return {messageId:row.dedupeKey};},{batchSize:3});
 assert.deepEqual(sent.slice(0,2),['personal',`reader-alert:${userId}`]);
 assert.match(sent[2]!,/^notice:1:/);
});
test('full batches keep draining within the budget, and a retry stops the drain',async()=>{
 await reset();
 for(let n=0;n<45;n++) await enqueue('drain-'+n);
 let sends=0;
 await drainNotificationBatches(pool,async row=>{sends++;return {messageId:row.dedupeKey};},{budgetMs:60_000});
 assert.equal(sends,45);
 await reset();
 for(let n=0;n<45;n++) await enqueue('busy-'+n);
 await drainNotificationBatches(pool,async()=>{throw new NotificationSendError('rate limited',{retryable:true});},{budgetMs:60_000});
 const counts=(await pool.query(`SELECT COUNT(*) FILTER (WHERE attempts=1)::int AS tried,COUNT(*) FILTER (WHERE attempts=0)::int AS waiting
  FROM app_notification_outbox WHERE status='pending'`)).rows[0];
 assert.deepEqual(counts,{tried:20,waiting:25});
 await reset();
 for(let n=0;n<45;n++) await enqueue('stop-'+n);
 sends=0;
 await drainNotificationBatches(pool,async row=>{sends++;return {messageId:row.dedupeKey};},{budgetMs:60_000,stopping:()=>true});
 assert.equal(sends,20,'a stopping runtime finishes its batch and goes no further');
 await reset();
 for(let n=0;n<45;n++) await enqueue('refused-'+n);
 sends=0;
 // The account is refused partway through a full batch: no further batch is tried this tick.
 await drainNotificationBatches(pool,async row=>{
  if(++sends>=20) throw new NotificationSendError('Email provider refused the account',{retryable:false,account:true});
  return {messageId:row.dedupeKey};
 },{budgetMs:60_000});
 assert.equal(sends,20,'a refused account stops the drain');
 assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM app_notification_outbox WHERE status='pending'`)).rows[0].n,26);
});
test('scheduler deduplicates and cancels stale renewed certifications',async()=>{
 await reset();const now=new Date();const expiry=new Date(now.getTime()+4*86400000);
 await ensureCertification(expiry);
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
  await ensureCertification(expiry);
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
  await ensureCertification(new Date('2030-05-20T12:00:00Z'));
  await pool.query("UPDATE user_certifications SET renewaldate=TIMESTAMP '2030-05-20 12:00:00.123456' WHERE usercertid=90001");
  const now=new Date('2030-05-15T12:00:00Z');await scheduleExpirationNotifications(pool,now);
  let sent=false;await runNotificationBatch(pool,async row=>{if(row.payload.sourceId===90001)sent=true;return {messageId:`micro-${row.id}`};},{now});
  assert.equal(sent,true);
});
