import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { initializeDemo } from '../../src/scripts/init-demo.js';

// Signup errors name the request-body property they are about, so the form can open
// that step without reading the message text.
const database='arbor_signup_fields_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const config={jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,allowedOrigins:['http://localhost:8080'],timeZone:'America/New_York'};
let created=false;
before(async()=>{if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PG required');await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
const person={firstName:'Field',lastName:'Test',email:'field@example.invalid',phone:'0000000000',dob:'2000-01-01',password:'ValidPassword!',timeZone:'America/New_York'};
// A fresh app per request keeps these cases under the sign-up rate limit.
const register=(body:object)=>request(createApp(pool,config)).post('/api/auth/register').send(body);

test('each invalid signup property is named in the error body',async()=>{
  const cases:Array<[string,object]>=[
    ['timeZone',{timeZone:'Not/AZone'}],
    ['firstName',{firstName:''}],
    ['lastName',{lastName:'x'.repeat(51)}],
    ['phone',{phone:'0'.repeat(16)}],
    ['phone',{phone:'call me'}],
    ['phone',{phone:'555-01'}],
    ['phone',{phone:'+1 (410) 555-0182 x123'}],
    ['phone',{phone:'1+410 555 0182'}],
    // With its +, a 15-digit number would not fit the 15-character column.
    ['phone',{phone:'+123456789012345'}],
    ['email',{email:'not-an-email'}],
    ['dob',{dob:'01/02/2000'}],
    ['dob',{dob:'2999-01-01'}],
    ['password',{password:'short'}],
    ['password',{password:'nouppercase!'}],
  ];
  for(const [field,change] of cases) {
    const response=await register({...person,...change});
    assert.equal(response.status,400,field);
    assert.equal(response.body.error.code,'INVALID_INPUT',field);
    assert.equal(response.body.error.field,field,JSON.stringify(change));
    assert.equal(typeof response.body.error.message,'string');
  }
  // Validation order is unchanged: the first invalid property is reported.
  assert.equal((await register({...person,firstName:'',password:'short'})).body.error.field,'firstName');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_pending_registration')).rows[0].n,0);
});

// Sign-up never says whether an address is a member's; the owner is emailed instead.
test('an address that already has an account is not reported as an error',async()=>{
  const response=await register({...person,email:'demo.member@collaboratory.invalid'});
  assert.equal(response.status,202);
  assert.equal(response.body.error,undefined);
});

test('errors outside signup keep their existing body',async()=>{
  const response=await request(createApp(pool,config)).post('/api/auth/login').send({email:'nobody@example.invalid',password:'WrongPassword!'});
  assert.equal(response.status,401);
  assert.deepEqual(response.body.error,{code:'INVALID_CREDENTIALS',message:'Email or password is incorrect.'});
  const accepted=await register(person);
  assert.equal(accepted.status,202);
  assert.equal(accepted.body.error,undefined);
});

test('a formatted phone number is saved whole, as its digits after any leading +',async()=>{
  // The + stays, as the profile saves it, so an international number is never shown as a US one.
  for(const [n,phone,saved] of [[1,'+1 (410) 555-0182','+14105550182'],[2,'(410) 555-0182','4105550182'],[3,'+49 30 123456','+4930123456']] as const){
    const email=`formatted-phone-${n}@example.invalid`;
    assert.equal((await register({...person,email,phone})).status,202);
    const row=(await pool.query('SELECT phone FROM app_pending_registration WHERE email=$1',[email])).rows[0];
    assert.equal(row.phone,saved);
  }
});
