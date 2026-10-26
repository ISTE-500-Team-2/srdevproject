import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before, after, test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';

const database = 'arbor_policy_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner = new Pool({connectionTimeoutMillis:5000});
const pool = new Pool({database,connectionTimeoutMillis:5000,statement_timeout:5000});
let created = false;
let app:ReturnType<typeof createApp>;
type Actor = {id:number;token:string;csrf:string};
let admin:Actor, member:Actor;
async function login(role:string):Promise<Actor> {
  const r = await request(app).post('/api/auth/demo').send({role});
  assert.equal(r.status,200);
  return {id:r.body.data.user.id,token:r.body.data.accessToken,csrf:r.body.data.csrfToken};
}
function get(path:string, actor=admin) {
  return request(app).get('/api'+path).set('Authorization','Bearer '+actor.token);
}
function post(path:string, body:unknown, actor=admin) {
  return request(app).post('/api'+path).set('Authorization','Bearer '+actor.token)
    .set('X-CSRF-Token',actor.csrf).send(body);
}
function policy(name:string,version='v1',effectiveAt=new Date(Date.now()-60000).toISOString()) {
  return {name,version,effectiveAt,description:'Approved test policy wording. Preserve this exact signed text.',
    approvalReference:'Isolated integration fixture, not sponsor approval',reason:'Exercise transactional policy replacement'};
}
async function publish(body:ReturnType<typeof policy>) {
  const r=await post('/admin/policies',body);
  assert.equal(r.status,201,JSON.stringify(r.body));
  return r.body.data;
}
async function versions(name:string) {
  return (await pool.query('SELECT waiverid AS id,version,isactive AS active,description FROM waiver WHERE name=$1 ORDER BY waiverid',[name])).rows;
}
before(async()=>{
  if(!process.env.PGHOST || process.env.DATABASE_URL) throw Error('Use an explicit isolated PostgreSQL instance');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;
  await initializeDemo(pool);
  app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,
    demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
  admin=await login('admin');member=await login('member');
});
after(async()=>{
  await pool.end();
  if(created) await owner.query(`DROP DATABASE "${database}"`);
  await owner.end();
});

test('replacement retires the previous version, preserves signed history and requires fresh agreement',async()=>{
  const body=policy('Atomic replacement');
  const first=await publish(body);
  assert.equal((await post(`/me/waivers/${first.id}/sign`,{accepted:true},member)).status,200);
  const signature=(await get('/me/signed-waivers',member)).body.data.find((w:any)=>w.waiverId===first.id);
  const next=await publish({...body,version:'v2',description:'New approved wording. A fresh electronic agreement is required.',effectiveAt:new Date(Date.now()-1000).toISOString()});
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[first.id,false],[next.id,true]]);
  const current=(await get('/me/waivers',member)).body.data.find((w:any)=>w.name===body.name);
  assert.equal(current.id,next.id);assert.equal(current.signed,false);assert.equal(current.outdatedSignature,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_waiver WHERE userid=$1 AND waiverid=$2',[member.id,first.id])).rows[0].n,1);
  const copy=await get(`/me/signed-waivers/${signature.id}/copy`,member);
  assert.equal(copy.status,200);assert.ok(copy.body.data.content.includes(body.description));
  assert.equal((await versions(body.name))[0].description,body.description);
  assert.equal((await post(`/me/waivers/${next.id}/sign`,{accepted:true},member)).status,200);
  assert.equal((await get('/me/waivers',member)).body.data.find((w:any)=>w.name===body.name).signed,true);
  const audit=(await pool.query("SELECT actor_id,action,before_state,after_state FROM app_staff_audit WHERE entity_type='waiver' AND entity_id=ANY($1::int[]) AND action IN ('policy.published','policy.retired') ORDER BY id",[[first.id,next.id]])).rows;
  assert.deepEqual(audit.map(a=>a.action),['policy.published','policy.published','policy.retired']);
  assert.ok(audit.every(a=>a.actor_id===admin.id));
  assert.equal(audit[2].before_state.active,true);assert.equal(audit[2].after_state.active,false);
});

test('duplicate publication and unauthorized replacement cannot retire the current version',async()=>{
  const body=policy('Rejected replacement');
  const first=await publish(body);
  assert.equal((await post('/admin/policies',{...body,version:'unauthorized'},member)).status,403);
  assert.equal((await post('/admin/policies',body)).status,409);
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[first.id,true]]);
});

test('retirement audit failure rolls back publication, flags and all application audit events',async()=>{
  const body=policy('Rollback replacement');
  const first=await publish(body);
  await pool.query(`CREATE FUNCTION fail_test_policy_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='policy.retired' AND NEW.before_state->>'name'='Rollback replacement' THEN
      RAISE EXCEPTION 'Injected policy retirement audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_policy_retirement BEFORE INSERT ON app_staff_audit
    FOR EACH ROW EXECUTE FUNCTION fail_test_policy_retirement()`);
  try {
    assert.equal((await post('/admin/policies',{...body,version:'v2',effectiveAt:new Date().toISOString()})).status,500);
    assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[first.id,true]]);
    const events=(await pool.query("SELECT action FROM app_staff_audit WHERE entity_type='waiver' AND (before_state->>'name'=$1 OR after_state->>'name'=$1) AND action IN ('policy.published','policy.retired')",[body.name])).rows;
    assert.deepEqual(events.map(e=>e.action),['policy.published']);
  } finally {
    await pool.query('DROP TRIGGER fail_test_policy_retirement ON app_staff_audit; DROP FUNCTION fail_test_policy_retirement()');
  }
});

test('concurrent same-time replacements serialize to exactly one current version',async()=>{
  const body=policy('Concurrent replacement');
  await publish(body);
  const effectiveAt=new Date(Date.now()-1000).toISOString();
  const responses=await Promise.all(['v2','v3'].map(version=>post('/admin/policies',{...body,version,effectiveAt})));
  assert.ok(responses.every(r=>r.status===201),responses.map(r=>JSON.stringify(r.body)).join('\n'));
  const rows=await versions(body.name);
  assert.equal(rows.filter(w=>w.active).length,1);
  assert.equal(rows.find(w=>w.active).id,Math.max(...rows.map(w=>w.id)));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_staff_audit WHERE action='policy.retired' AND before_state->>'name'=$1",[body.name])).rows[0].n,2);
});

test('backdated publication cannot retire a newer effective version',async()=>{
  const body=policy('Backdated replacement','current',new Date(Date.now()-1000).toISOString());
  const current=await publish(body);
  const older=await publish({...body,version:'historical',effectiveAt:new Date(Date.now()-86400000).toISOString()});
  assert.equal(older.active,false);
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[current.id,true],[older.id,false]]);
});

test('scheduled replacement preserves current agreement until due, then retires automatically without email configuration',async()=>{
  const body=policy('Scheduled replacement');
  const current=await publish(body);
  assert.equal((await post(`/me/waivers/${current.id}/sign`,{accepted:true},member)).status,200);
  const future=await publish({...body,version:'future',effectiveAt:new Date(Date.now()+86400000).toISOString()});
  assert.ok((await versions(body.name)).every(w=>w.active));
  let required=(await get('/me/waivers',member)).body.data.find((w:any)=>w.name===body.name);
  assert.equal(required.id,current.id);assert.equal(required.signed,true);
  const {runPolicyRetirement,startPolicyRuntime}=await import('../../src/policyLifecycle.js');
  assert.equal(await runPolicyRetirement(pool),0);
  assert.ok((await versions(body.name)).every(w=>w.active));
  // Move only this disposable fixture's effective date to simulate time passing.
  await pool.query("UPDATE waiver SET effectivedate=(NOW()-INTERVAL '1 second') AT TIME ZONE 'UTC' WHERE waiverid=$1",[future.id]);
  const runtime=startPolicyRuntime(pool);
  await runtime.stop(); // joins the startup scan; no sleeps or external delivery
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[current.id,false],[future.id,true]]);
  required=(await get('/me/waivers',member)).body.data.find((w:any)=>w.name===body.name);
  assert.equal(required.id,future.id);assert.equal(required.signed,false);assert.equal(required.outdatedSignature,true);
  const audit=(await pool.query("SELECT actor_id,reason,after_state FROM app_staff_audit WHERE action='policy.retired' AND entity_id=$1",[current.id])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,null);
  assert.match(audit[0].reason,/Scheduled replacement/);assert.equal(audit[0].after_state.supersededBy,future.id);
  assert.equal(audit[0].after_state.replacementPublishedBy,admin.id);
  assert.equal(await runPolicyRetirement(pool),0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_staff_audit WHERE action='policy.retired' AND entity_id=$1",[current.id])).rows[0].n,1);
});

test('withdrawing a future version leaves the current version active',async()=>{
  const body=policy('Withdraw scheduled replacement');
  const current=await publish(body);
  const future=await publish({...body,version:'future',effectiveAt:new Date(Date.now()+86400000).toISOString()});
  assert.equal((await post(`/admin/policies/${future.id}/retire`,{reason:'Withdraw future policy before effective date'})).status,200);
  const {runPolicyRetirement}=await import('../../src/policyLifecycle.js');
  await runPolicyRetirement(pool);
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[current.id,true],[future.id,false]]);
});

test('manual retirement after a scheduled activation cannot revive the obsolete agreement before the next scan',async()=>{
  const body=policy('Retire just-activated replacement');
  const current=await publish(body);
  const future=await publish({...body,version:'future',effectiveAt:new Date(Date.now()+86400000).toISOString()});
  await pool.query("UPDATE waiver SET effectivedate=(NOW()-INTERVAL '1 second') AT TIME ZONE 'UTC' WHERE waiverid=$1",[future.id]);
  assert.equal((await post(`/admin/policies/${future.id}/retire`,{reason:'Withdraw current agreement safely'})).status,200);
  assert.deepEqual((await versions(body.name)).map(w=>[w.id,w.active]),[[current.id,false],[future.id,false]]);
  assert.equal((await get('/me/waivers',member)).body.data.some((w:any)=>w.name===body.name),false);
});
