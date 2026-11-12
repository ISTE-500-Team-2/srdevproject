import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {enqueueNotification,updateNotificationPreferences} from '../../src/notifications/store.js';
import {runNotificationBatch} from '../../src/notifications/worker.js';
import {startNotificationRuntime} from '../../src/notifications/runtime.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_notification_preflight_mvc_test';
const admin=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let userId:number;
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
  await admin.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  userId=(await pool.query(`SELECT userid FROM "user" WHERE status='active' ORDER BY userid LIMIT 1`)).rows[0].userid;
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();});
async function reset() {await pool.query('DELETE FROM app_notification_outbox');await updateNotificationPreferences(pool,userId,{enabled:true,timeZone:'America/New_York'});}
/** The worker's own pool, except the member eligibility check fails the first `failures` times. */
function flakyPool(failures:number) {
  return new Proxy(pool,{get(target,key) {
    if(key==='query') return (sql:unknown,...rest:unknown[])=>{
      if(typeof sql==='string' && sql.includes('LEFT JOIN app_notification_preferences p USING(userid)') && failures-->0)
        return Promise.reject(Object.assign(new Error('connection terminated'),{code:'57P01'}));
      return (target.query as (...args:unknown[])=>unknown)(sql,...rest);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function' ? value.bind(target) : value;
  }}) as Pool;
}
const outbox=async(key:string)=>(await pool.query('SELECT status,attempts,last_error,due_at FROM app_notification_outbox WHERE dedupe_key=$1',[key])).rows[0];

test('a database error before dispatch retries later instead of becoming uncertain',async()=>{
  await reset();
  await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:'preflight',payload:{}});
  const now=new Date(Date.now()+1000);let sends=0;
  const send=async()=>{sends++;return {messageId:`preflight-${sends}`};};
  const first=await runNotificationBatch(flakyPool(1),send,{now});
  assert.deepEqual({retried:first.retried,uncertain:first.uncertain},{retried:1,uncertain:0});
  assert.equal(sends,0);
  const queued=await outbox('preflight');
  assert.equal(queued.status,'pending');assert.equal(queued.last_error,'preflight_failed');assert.equal(queued.attempts,1);
  assert.equal(queued.due_at.getTime(),now.getTime()+30000);
  // Not due yet: nothing is sent.
  assert.equal((await runNotificationBatch(pool,send,{now:new Date(now.getTime()+29000)})).accepted,0);
  assert.equal(sends,0);
  const second=await runNotificationBatch(pool,send,{now:new Date(now.getTime()+31000)});
  assert.equal(second.accepted,1);assert.equal(sends,1);
  assert.equal((await outbox('preflight')).status,'accepted');
  await runNotificationBatch(pool,send,{now:new Date(now.getTime()+1e7)});
  assert.equal(sends,1);
});

test('repeated preflight failures stop at the attempt limit as failed, never uncertain',async()=>{
  await reset();
  await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:'preflight-limit',payload:{}});
  const now=new Date(Date.now()+1000);
  const send=async()=>{throw new Error('must not send');};
  assert.equal((await runNotificationBatch(flakyPool(5),send,{now,maxAttempts:2})).retried,1);
  const result=await runNotificationBatch(flakyPool(5),send,{now:new Date(now.getTime()+31000),maxAttempts:2});
  assert.equal(result.failed,1);assert.equal(result.uncertain,0);
  const row=await outbox('preflight-limit');
  assert.equal(row.status,'failed');assert.equal(row.last_error,'preflight_failed');
});

test('errors after the provider call keep the uncertain classification',async()=>{
  await reset();
  await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:'post-dispatch',payload:{}});
  const result=await runNotificationBatch(pool,async()=>{throw new Error('socket hang up');},{now:new Date(Date.now()+1000)});
  assert.equal(result.uncertain,1);
  const row=await outbox('post-dispatch');
  assert.equal(row.status,'uncertain');assert.equal(row.last_error,'provider_acceptance_unknown');
});

test('a template that cannot render fails permanently without contacting the provider',async()=>{
  await reset();
  // A signed-waiver notice without its required text cannot be rendered.
  await enqueueNotification(pool,{userId,kind:'waiver_signed',dedupeKey:'unrenderable',payload:{waiverName:'Incomplete'}});
  const realFetch=globalThis.fetch;let fetches=0;
  globalThis.fetch=(async()=>{fetches++;throw new Error('provider must not be contacted');}) as typeof fetch;
  try {
    const runtime=startNotificationRuntime(pool,{apiKey:'test-key',senderEmail:'sender@example.com',senderName:'Test Studio',
      replyToEmail:'reply@example.com',postalAddress:'1 Test Road',appOrigin:'http://localhost:8080',intervalMs:3600000});
    await runtime.stop();
  } finally {globalThis.fetch=realFetch;}
  const row=await outbox('unrenderable');
  assert.equal(row.status,'failed');assert.equal(row.last_error,'render_failed');
  assert.equal(fetches,0);
});

test('worker tick failures log only the stage, error class and SQLSTATE',async()=>{
  const secret='member@example.com';
  const failing={query:async()=>{throw Object.assign(new Error(`could not reach ${secret}`),{code:'57P01'});},
    connect:async()=>{throw new Error(secret);}} as unknown as Pool;
  const logged:unknown[][]=[];const realError=console.error;
  console.error=(...args:unknown[])=>{logged.push(args);};
  try {await startNotificationRuntime(failing).stop();} finally {console.error=realError;}
  assert.equal(logged.length,1);
  assert.deepEqual(logged[0]![1],{stage:'prune_registrations',error:'Error',code:'57P01',type:undefined});
  assert.doesNotMatch(JSON.stringify(logged),/member@example\.com|could not reach/);
});
