import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {PassBilling} from '../../src/billing/passes.js';
import {BillingPricing} from '../../src/billing/pricing.js';
import {StudioStripe} from '../../src/studios/stripe.js';
const database='arbor_requirements_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});let created=false,member:number,admin:number,plan:any,monthly:any,session:any,params:any,refundCalls=0;
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const service=new PassBilling(pool,provider),pricing=new BillingPricing(pool);
(provider.sdk.checkout.sessions.create as any)=async(p:any)=>{params=p;session={...p,id:'cs_'+randomBytes(5).toString('hex'),livemode:false,status:'open',url:'https://checkout.stripe.com/test',amount_total:p.line_items[0].price_data.unit_amount,currency:'usd'};return session;};
(provider.sdk.checkout.sessions.retrieve as any)=async()=>session;
(provider.sdk.checkout.sessions.expire as any)=async()=>({...session,status:'expired'});
(provider.sdk.refunds.list as any)=async()=>({data:[],has_more:false});
(provider.sdk.refunds.create as any)=async(p:any)=>{refundCalls++;return {id:'re_pass',...p,currency:'usd',status:'succeeded'};};
const event=(id:string)=>({id,livemode:false,type:'checkout.session.completed',data:{object:session}} as any);
const input=(date:string,amount=1500,rev=0)=>({planId:plan.id,expectedRevision:plan.revision,pricingRevision:rev,amountCents:amount,validDate:date});
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 member=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
 admin=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
 plan=(await pool.query("SELECT tierid AS id,revision FROM membership_tiers WHERE kind='day_pass' LIMIT 1")).rows[0];
 monthly=(await pool.query("SELECT tierid AS id,revision FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0];
 await pool.query('UPDATE membership_tiers SET tierprice=15 WHERE tierid=$1',[plan.id]);
 await pool.query('UPDATE membership_tiers SET tierprice=50,allottedmonths=1 WHERE tierid=$1',[monthly.id]);
 // Fixture approved waivers; never disable gates in the service.
 await pool.query(`INSERT INTO user_waiver(userid,waiverid,approval,signdate) SELECT $1,waiverid,true,now() FROM waiver WHERE isactive=true AND required=true`,[member]);
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
test('day-pass checkout gates price, calendar date, waiver, and ownership; paid signed-event service creates one pass/receipt',async()=>{
 await assert.rejects(service.checkout(member,input('2030-01-10',1)),{code:'PRICE_CHANGED'});
 await assert.rejects(service.checkout(member,input('2030-02-30')),{code:'INVALID_INPUT'});
 await service.checkout(member,input('2030-01-10'));
 assert.equal(params.mode,'payment');assert.equal(params.line_items[0].price_data.unit_amount,1500);
 assert.equal((await pool.query('SELECT * FROM app_pass_checkout WHERE pass_id IS NOT NULL')).rowCount,0);
 await service.checkout(member,input('2030-01-10'));session={...session,status:'complete',payment_status:'paid',payment_intent:'pi_pass'};
 await service.webhook(event('evt_pass'));await service.webhook(event('evt_pass_again'));
 const r=(await pool.query('SELECT * FROM app_pass_checkout')).rows[0];assert.ok(r.pass_id);assert.equal(r.status,'paid');
 assert.equal((await pool.query("SELECT * FROM app_notification_outbox WHERE dedupe_key=$1",['daypass-receipt:'+r.id])).rowCount,1);
 await assert.rejects(service.cancel(admin,r.id),{code:'NOT_FOUND'});
 await service.cancel(member,r.id);await service.cancel(member,r.id);assert.equal(refundCalls,1);
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[r.payment_id])).rows[0].paymentstatus,'refunded');
 assert.equal((await pool.query('SELECT status FROM day_pass WHERE dayid=$1',[r.pass_id])).rows[0].status,'cancelled');
});
test('student discount cannot be self-claimed; approved rates are revisioned; partner access expires',async()=>{
 await assert.rejects(pricing.configure(member,plan.id,{studentCents:1000,partnerFree:true,revision:0,reason:'Test approval'}),{code:'STAFF_REQUIRED'});
 await pricing.configure(admin,plan.id,{studentCents:1000,partnerFree:true,revision:0,reason:'Approved fixture rates'});
 await assert.rejects(pricing.configure(admin,plan.id,{studentCents:1000,partnerFree:true,revision:0,reason:'Stale rate'}),{code:'PRICE_CHANGED'});
 await service.checkout(member,{...input('2030-02-10',1500,1),isStudent:true});assert.equal(params.line_items[0].price_data.unit_amount,1500);
 const pending=(await service.mine(member)).find(p=>p.status==='pending')!;await service.cancel(member,pending.id);
 await pool.query('UPDATE "user" SET is_student=true WHERE userid=$1',[member]);
 await service.checkout(member,input('2030-02-10',1000,1));assert.equal(params.line_items[0].price_data.unit_amount,1000);
 await service.cancel(member,(await service.mine(member)).find(p=>p.status==='pending')!.id);
 await assert.rejects(pricing.verifyPartner(member,member,{reference:'Fake school',validUntil:'2030-03-01'}),{code:'STAFF_REQUIRED'});
 await pricing.verifyPartner(admin,member,{reference:'Approved test school partnership',validUntil:'2030-03-01'});
 await service.checkout(member,input('2030-02-10',0,1));
 assert.equal((await pool.query("SELECT * FROM app_pass_checkout WHERE status='paid' AND amount_cents=0")).rowCount,1);
 const after=(await pricing.offers(member,'2030-03-02')).find(p=>p.id===plan.id)!;assert.equal(after.amountCents,1000);
});
test('day-pass cancellation enforces three-day cutoff without changing paid records',async()=>{
 const row=(await pool.query("SELECT * FROM app_pass_checkout WHERE status='paid' AND amount_cents=0")).rows[0];
 await pool.query("UPDATE app_pass_checkout SET valid_date=(now() AT TIME ZONE 'America/New_York')::date+2 WHERE id=$1",[row.id]);
 await assert.rejects(service.cancel(member,row.id),{code:'CANCELLATION_NOTICE'});
 assert.equal((await pool.query('SELECT cancel_requested_at FROM app_pass_checkout WHERE id=$1',[row.id])).rows[0].cancel_requested_at,null);
});
test('free monthly access requires verified eligibility covering the period and does not create a subscription',async()=>{
 await pricing.configure(admin,monthly.id,{studentCents:null,partnerFree:true,revision:0,reason:'Approved school access'});
 await pool.query("UPDATE user_membership SET status='expired' WHERE userid=$1",[member]);
 await service.freeMembership(member,{planId:monthly.id,expectedRevision:monthly.revision,pricingRevision:1});
 assert.equal((await pool.query('SELECT * FROM app_membership_billing WHERE userid=$1',[member])).rowCount,0);
 assert.equal((await pool.query("SELECT * FROM payment WHERE userid=$1 AND paymentstatus='waived' AND membershipid IS NOT NULL",[member])).rowCount,1);
 await assert.rejects(service.freeMembership(member,{planId:monthly.id,expectedRevision:monthly.revision,pricingRevision:1}),{code:'MEMBERSHIP_EXISTS'});
});

test('manual cash cancellation requests staff refund without fabricating a completed refund',async()=>{
 const {StaffModel}=await import('../../src/models/StaffModel.js');const model=new StaffModel(pool);
 const p=await model.plan(plan.id);assert.ok(p);
 const pass=await model.createPass(member,p,'2030-06-01',admin,'Cash sale fixture');
 const payment=await model.createPayment(member,null,'15.00','paid','cash','CASH-42','Cash received',admin);await model.linkPassPayment(pass,payment);
 await assert.rejects(service.cancel(admin,'manual:'+pass),{code:'NOT_FOUND'});
 assert.equal((await service.cancel(member,'manual:'+pass)).manualRefundRequired,true);
 assert.equal((await service.cancel(member,'manual:'+pass)).manualRefundRequired,true);
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[payment])).rows[0].paymentstatus,'paid');
 assert.equal((await pool.query("SELECT * FROM app_staff_audit WHERE action='daypass.cancelled' AND entity_id=$1",[pass])).rowCount,1);
});
test('missing waiver blocks purchase and unverified users cannot claim a free monthly plan',async()=>{
 await pool.query('UPDATE user_waiver SET approval=false WHERE userid=$1',[member]);
 await assert.rejects(service.checkout(member,input('2030-04-10',1000,1)),{code:'WAIVER_REQUIRED'});
 await pool.query('UPDATE user_waiver SET approval=true WHERE userid=$1',[member]);
 await pricing.verifyPartner(admin,member,{reference:'Test eligibility revoked',validUntil:'2000-01-01'});
 await assert.rejects(service.freeMembership(member,{planId:monthly.id,expectedRevision:monthly.revision,pricingRevision:1}),{code:'FREE_ACCESS_INELIGIBLE'});
});

test('refund before checkout delivery cannot grant usable access on a late paid event',async()=>{
 await service.checkout(member,input('2030-07-10',1000,1));session={...session,status:'complete',payment_status:'paid',payment_intent:'pi_early_refund'};
 (provider.sdk.refunds.list as any)=async()=>({has_more:false,data:[{id:'re_early',payment_intent:'pi_early_refund',currency:'usd',amount:1000,status:'succeeded'}]});
 await service.webhook(event('evt_late_checkout'));
 const r=(await pool.query("SELECT * FROM app_pass_checkout WHERE payment_intent='pi_early_refund'")).rows[0];assert.equal(r.status,'cancelled');
 assert.equal((await pool.query('SELECT status FROM day_pass WHERE dayid=$1',[r.pass_id])).rows[0].status,'cancelled');
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[r.payment_id])).rows[0].paymentstatus,'refunded');
});
