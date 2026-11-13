import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';
import { confirmationToken } from '../helpers/confirmation.js';

const database='arbor_change_log_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'};
const app=createApp(pool,config);
type Session={accessToken:string;csrfToken:string;user:{id:number}};
type Item={id:string;action:string;entityType:string;actorId:number|null;subjectId:number|null;resourceName:string|null};
let created=false,admin:Session,member:Session,target:Session,roleChange:Item;
const HOUSEKEEPING=['app_session','app_refresh_token','app_refresh_family'];

const as=(who:Session)=>({
  get:(path:string)=>request(app).get('/api'+path).set('Authorization','Bearer '+who.accessToken),
  post:(path:string,body:object={})=>request(app).post('/api'+path).set('Authorization','Bearer '+who.accessToken).set('X-CSRF-Token',who.csrfToken).send(body),
});
const sources=async(items:Item[])=>(await pool.query(
  'SELECT DISTINCT source,entity_type FROM app_staff_audit WHERE id=ANY($1::bigint[])',[items.map(i=>i.id)])).rows as {source:string;entity_type:string}[];

before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  admin=(await request(app).post('/api/auth/demo').send({role:'admin'})).body.data;
  member=(await request(app).post('/api/auth/demo').send({role:'member'})).body.data;
  // Someone else is promoted, so the demo member stays a member without change log access.
  const email='changelog-target@example.invalid';
  assert.equal((await request(app).post('/api/auth/register').send({firstName:'Quill',lastName:'Ledgerwood',email,phone:'1112223333',dob:'1990-01-01',password:'GoodPassword123!'})).status,202);
  target=(await request(app).post('/api/auth/confirm').send({token:await confirmationToken(pool,email)})).body.data;
  const person=(await as(admin).get(`/admin/users/${target.user.id}`)).body.data.user;
  const changed=await as(admin).post(`/admin/users/${target.user.id}/role`,{role:'staff',revision:person.revision,reason:'Change log fixture'});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  const found=await as(admin).get(`/admin/audit?view=staff&action=user.role_changed&userId=${target.user.id}`);
  roleChange=found.body.data.items[0];
  assert.ok(roleChange,'the role change is a staff action');
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

test('views split staff actions from database writes and leave sign-in bookkeeping out',async()=>{
  // Signing in wrote session rows: the unfiltered log still has them, for older callers.
  const legacy=await as(admin).get('/admin/audit?action=app_session.insert');
  assert.equal(legacy.status,200);
  assert.ok(legacy.body.data.items.length>0);
  assert.equal('counts' in legacy.body.data,false,'totals are only computed when a view is asked for');

  const staff=await as(admin).get('/admin/audit?view=staff');
  assert.equal(staff.status,200,JSON.stringify(staff.body));
  assert.deepEqual([...new Set((await sources(staff.body.data.items)).map(r=>r.source))],['application']);
  const listed=staff.body.data.items.find((i:Item)=>i.id===roleChange.id);
  assert.ok(listed);
  // The list stays lean: reasons and stored states only come with the record itself.
  for(const key of ['reason','before','after','changes']) assert.equal(key in listed,false,key);

  const writes=await as(admin).get('/admin/audit?view=database');
  assert.equal(writes.status,200);
  const kinds=await sources(writes.body.data.items);
  assert.ok(kinds.length>0);
  assert.ok(kinds.every(r=>r.source==='database'&&!HOUSEKEEPING.includes(r.entity_type)&&r.entity_type!=='app_device_access_event'),JSON.stringify(kinds));

  const {counts}=staff.body.data;
  assert.equal(typeof counts.staff,'number');
  assert.ok(counts.staff>=1&&counts.database>=1);
  assert.deepEqual(writes.body.data.counts,counts,'every view reports the same totals');
  const all=(await pool.query(`SELECT COUNT(*)::int n FROM app_staff_audit WHERE source='database' AND entity_type NOT IN ('app_device_access_event',${HOUSEKEEPING.map(t=>`'${t}'`).join(',')})`)).rows[0].n;
  assert.equal(counts.database,all);
  assert.equal((await as(admin).get('/admin/audit?view=everything')).status,400);
});

test('search matches names and actions literally; an action list narrows to those actions',async()=>{
  const byName=await as(admin).get('/admin/audit?view=staff&search=ledgerWOOD');
  assert.equal(byName.status,200);
  assert.ok(byName.body.data.items.some((i:Item)=>i.id===roleChange.id));
  const byAction=await as(admin).get('/admin/audit?view=staff&search=role%20changed');
  assert.ok(byAction.body.data.items.some((i:Item)=>i.id===roleChange.id));
  // LIKE wildcards are searched for, not used.
  const wildcard=await as(admin).get('/admin/audit?view=staff&search=%25');
  assert.equal(wildcard.status,200);
  assert.equal(wildcard.body.data.items.length,0);

  const narrowed=await as(admin).get('/admin/audit?view=staff&actions=user.role_changed,plan.created');
  assert.equal(narrowed.status,200);
  assert.ok(narrowed.body.data.items.length>0);
  assert.ok(narrowed.body.data.items.every((i:Item)=>['user.role_changed','plan.created'].includes(i.action)));
  const none=await as(admin).get('/admin/audit?view=staff&actions=');
  assert.deepEqual(none.body.data,{items:[],nextOffset:null,counts:{staff:0,taps:0,database:0}});
  assert.equal((await as(admin).get('/admin/audit?actions=Not%20An%20Action')).status,400);
});

test('a record shows its reason, what changed, and the writes saved with it',async()=>{
  const record=await as(admin).get(`/admin/audit/${roleChange.id}`);
  assert.equal(record.status,200,JSON.stringify(record.body));
  const data=record.body.data;
  assert.equal(data.reason,'Change log fixture');
  assert.equal(data.source,'application');
  assert.equal('before' in data,false);
  assert.ok(data.changes.changed.length>0,JSON.stringify(data.changes));
  const fields=[...data.changes.changed,...data.changes.unchanged].map((f:{field:string})=>f.field);
  assert.ok(fields.every((f:string)=>!/hash|password|token|revision/i.test(f)),fields.join());
  // The role change's own trigger rows were written in the same transaction.
  assert.ok(data.related.length>0);
  assert.ok(data.related.every((r:{source:string;entityType:string})=>r.source==='database'&&!HOUSEKEEPING.includes(r.entityType)));
  assert.equal(data.relatedCount,data.related.length);

  // And from one of those rows, the action behind it.
  const copy=await as(admin).get(`/admin/audit/${data.related[0].id}`);
  assert.equal(copy.status,200);
  assert.equal(copy.body.data.changes,null,'trigger rows keep no states');
  assert.ok(copy.body.data.related.some((r:{id:string})=>r.id===roleChange.id));

  assert.equal((await as(admin).get('/admin/audit/999999999')).status,404);
  assert.equal((await as(admin).get('/admin/audit/abc')).status,400);
  assert.equal((await as(member).get(`/admin/audit/${roleChange.id}`)).status,403);
});
