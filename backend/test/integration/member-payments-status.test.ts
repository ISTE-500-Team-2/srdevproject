import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

const database='arbor_member_payments_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'});
let created=false,member:{accessToken:string;user:{id:number}};
const get=(path:string)=>request(app).get('/api'+path).set('Authorization','Bearer '+member.accessToken);

before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  member=(await request(app).post('/api/auth/demo').send({role:'member'})).body.data;
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

test('a member can ask for paid payments only, so an abandoned checkout is never their latest payment',async()=>{
  const paid=(await pool.query(`INSERT INTO payment(userid,price,paymentstatus,paymentdate,method)
    VALUES($1,30,'paid',NOW() AT TIME ZONE 'UTC','card') RETURNING paymentid`,[member.user.id])).rows[0].paymentid;
  // Newer rows an equipment checkout leaves behind when it's abandoned or never finished.
  await pool.query(`INSERT INTO payment(userid,price,paymentstatus,paymentdate,method)
    VALUES($1,45,'void',NOW() AT TIME ZONE 'UTC','card'),($1,14,'pending',NOW() AT TIME ZONE 'UTC','card')`,[member.user.id]);
  const all=await get('/me/payments');
  assert.equal(all.status,200,JSON.stringify(all.body));
  assert.deepEqual(all.body.data.items.slice(0,3).map((p:{status:string})=>p.status),['pending','void','paid'],'the history still lists every payment');
  const onlyPaid=await get('/me/payments?offset=0&status=paid');
  assert.equal(onlyPaid.status,200,JSON.stringify(onlyPaid.body));
  assert.equal(onlyPaid.body.data.items[0].id,paid);
  assert.ok(onlyPaid.body.data.items.every((p:{status:string;userId:number})=>p.status==='paid'&&p.userId===member.user.id));
  assert.equal((await get('/me/payments?status=bogus')).status,400);
});
