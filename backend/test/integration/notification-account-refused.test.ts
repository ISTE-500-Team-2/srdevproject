import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {enqueueNotification,updateNotificationPreferences} from '../../src/notifications/store.js';
import {startNotificationRuntime} from '../../src/notifications/runtime.js';
const database='arbor_'+randomBytes(6).toString('hex')+'_notification_account_mvc_test';
const admin=new Pool({connectionTimeoutMillis:5000});
const pool=new Pool({database,connectionTimeoutMillis:5000});
let created=false;let userId:number;
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL)throw new Error('Use explicit isolated PostgreSQL settings');
  await admin.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  userId=(await pool.query(`SELECT userid FROM "user" WHERE status='active' ORDER BY userid LIMIT 1`)).rows[0].userid;
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();});
const secretKey='brevo-key-never-logged';
const config={apiKey:secretKey,senderEmail:'sender@example.com',senderName:'Test Studio',replyToEmail:'reply@example.com',
  postalAddress:'1 Test Road',appOrigin:'http://localhost:8080',intervalMs:3600000};
type Sent={subject:string;textContent:string;htmlContent:string};
/** One worker tick with Brevo answering every request with `respond`: what was sent and what was logged. */
async function tick(respond:()=>Response) {
  const sent:Sent[]=[];const logged:unknown[][]=[];
  const realFetch=globalThis.fetch;const realError=console.error;
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{sent.push(JSON.parse(String(init?.body)));return respond();}) as typeof fetch;
  console.error=(...args:unknown[])=>{logged.push(args);};
  try {await startNotificationRuntime(pool,config).stop();} finally {globalThis.fetch=realFetch;console.error=realError;}
  return {sent,logged,refusals:logged.filter(([message])=>String(message).includes('refused the studio account'))};
}
const outbox=async(key:string)=>(await pool.query('SELECT status,attempts,last_error FROM app_notification_outbox WHERE dedupe_key=$1',[key])).rows[0];

test('a refused Brevo account keeps every email queued, says so in the log, and sends them once fixed',async()=>{
  await pool.query('DELETE FROM app_notification_outbox');
  await updateNotificationPreferences(pool,userId,{enabled:true,timeZone:'America/New_York'});
  for(const key of ['refused-first','refused-second'])
    await enqueueNotification(pool,{userId,kind:'account_created',dedupeKey:key,payload:{}});
  for(const status of [401,402,403]) {
    const {sent,logged,refusals}=await tick(()=>new Response(`{"code":"unauthorized","message":"Key not found: ${secretKey}"}`,{status}));
    // One request, then the batch stops: every other email would be refused the same way.
    assert.equal(sent.length,1,`HTTP ${status}`);
    // Nothing is given up on, and the refused try doesn't count against the email.
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM app_notification_outbox WHERE status<>'pending'`)).rows[0].n,0);
    assert.deepEqual((await pool.query(`SELECT attempts FROM app_notification_outbox WHERE last_error='provider_account_rejected'`)).rows,[{attempts:0}]);
    assert.equal(refusals.length,1);
    assert.deepEqual(refusals[0]![1],{status});
    assert.doesNotMatch(JSON.stringify(logged),new RegExp(`${secretKey}|example\\.com|Key not found`));
  }
  let id=0;
  const {sent,refusals}=await tick(()=>Response.json({messageId:`<fixed-${++id}@test>`},{status:201}));
  assert.equal(refusals.length,0);
  for(const key of ['refused-first','refused-second']) assert.equal((await outbox(key)).status,'accepted',key);
  // The opt-out link lands on the notification settings, not the top of the profile.
  const welcome=sent.find((mail)=>mail.subject==='Test Studio: Your account has been created')!;
  assert.match(welcome.textContent,/notification settings: http:\/\/localhost:8080\/profile#notifications$/m);
  assert.ok(welcome.htmlContent.includes('href="http://localhost:8080/profile#notifications"'));
});
