import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {after,before,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {PassBilling} from '../../src/billing/passes.js';
import {StudioStripe} from '../../src/studios/stripe.js';

const database='arbor_payment_waivers_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const service=new PassBilling(pool,provider);
let created=false,member:number,pass:any,monthly:any,providerCalls=0;
(provider.sdk.checkout.sessions.create as any)=async()=>{providerCalls++;throw Error('Provider must not be called for an ineligible purchase');};
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;
  await initializeDemo(pool);
  member=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
  pass=(await pool.query("SELECT tierid AS id,revision FROM membership_tiers WHERE kind='day_pass' LIMIT 1")).rows[0];
  monthly=(await pool.query("SELECT tierid AS id,revision FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0];
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
async function financialState(){
  return (await pool.query(`SELECT (SELECT count(*) FROM app_pass_checkout) AS checkouts,
    (SELECT count(*) FROM day_pass) AS passes,(SELECT count(*) FROM payment) AS payments,
    (SELECT count(*) FROM user_membership) AS memberships,
    (SELECT count(*) FROM app_notification_outbox) AS notifications`)).rows[0];
}
for(const [name,configuration,code,status] of [
  ['missing policies','DELETE FROM user_waiver; DELETE FROM waiver','WAIVERS_NOT_CONFIGURED',409],
  ['retired policies',"UPDATE waiver SET isactive=false",'WAIVERS_NOT_CONFIGURED',409],
  ['future policies',"UPDATE waiver SET effectivedate=(now()+interval '1 day') AT TIME ZONE 'UTC'",'WAIVERS_NOT_CONFIGURED',409],
  ['optional-only policies',"UPDATE waiver SET required=false",'WAIVERS_NOT_CONFIGURED',409],
  ['unsigned required policies','DELETE FROM user_waiver','WAIVER_REQUIRED',403],
  ['expired signatures',"INSERT INTO user_waiver(userid,waiverid,approval,signdate,expires_at) SELECT $1,waiverid,true,now()-interval '2 days',now()-interval '1 day' FROM waiver",'WAIVER_REQUIRED',403],
] as const){
  test(`${name} block paid day passes and free memberships before financial writes or Stripe requests`,async()=>{
    // Each case starts with a current required policy; configuration changes are
    // confined to this dedicated test database, never a production fixture.
    await pool.query('DELETE FROM user_waiver; DELETE FROM waiver');
    await pool.query("INSERT INTO waiver(name,version,description,effectivedate,isactive,required) VALUES('Test policy','1','Nonbinding fixture',now() AT TIME ZONE 'UTC',true,true)");
    await pool.query(configuration,configuration.includes('$1')?[member]:[]);
    const before=await financialState();
    await assert.rejects(service.checkout(member,{planId:pass.id,expectedRevision:pass.revision,pricingRevision:0,amountCents:1500,validDate:'2030-01-10'}),{code,status});
    await assert.rejects(service.freeMembership(member,{planId:monthly.id,expectedRevision:monthly.revision,pricingRevision:0}),{code,status});
    assert.deepEqual(await financialState(),before);
    assert.equal(providerCalls,0);
  });
}
