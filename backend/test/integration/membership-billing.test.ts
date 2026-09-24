import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {MembershipBilling} from '../../src/billing/service.js';
import {StudioStripe} from '../../src/studios/stripe.js';
import {createApp} from '../../src/app.js';
const database='arbor_billing_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});let created=false,userid:number,other:number,plan:any,row:any;
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const service=new MembershipBilling(pool,provider);
let checkoutParams:any,checkoutCalls=0,sub:any,invoice:any;
(provider.sdk.checkout.sessions.create as any)=async(p:any)=>{checkoutParams=p;checkoutCalls++;return {id:'cs_billing',livemode:false,status:'open',url:'https://checkout.stripe.com/test'};};
(provider.sdk.checkout.sessions.retrieve as any)=async()=>({id:'cs_billing',livemode:false,status:'open',url:'https://checkout.stripe.com/test'});
(provider.sdk.subscriptions.retrieve as any)=async()=>sub;
(provider.sdk.invoices.retrieve as any)=async()=>invoice;
(provider.sdk.subscriptions.update as any)=async(_id:any,p:any)=>(sub={...sub,...p});
const event=(id:string,type:string,object:any)=>({id,livemode:false,type,data:{object}} as any);
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 userid=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
 other=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
 await pool.query("UPDATE user_membership SET status='expired',end_date=now()-interval '1 day' WHERE userid=$1",[userid]);
 plan=(await pool.query("SELECT tierid AS id,revision FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0];
 await pool.query("UPDATE membership_tiers SET allottedmonths=1,tierprice=50,active=true WHERE tierid=$1",[plan.id]);
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
test('explicit renewal consent and current server price required; checkout retries create one session',async()=>{
 const input={planId:plan.id,expectedRevision:plan.revision,autoRenewConsent:true};
 await assert.rejects(service.checkout(userid,{...input,autoRenewConsent:false}),{code:'CONSENT_REQUIRED'});
 await assert.rejects(service.checkout(userid,{...input,expectedRevision:999}),{code:'PRICE_CHANGED'});
 await service.checkout(userid,input);await service.checkout(userid,input);
 assert.equal(checkoutCalls,1);assert.equal(checkoutParams.mode,'subscription');
 assert.equal(checkoutParams.line_items[0].price_data.recurring.interval,'month');
 assert.equal(checkoutParams.line_items[0].price_data.unit_amount,5000);
 assert.equal(checkoutParams.payment_method_types,undefined);
 row=(await pool.query('SELECT * FROM app_membership_billing WHERE userid=$1',[userid])).rows[0];
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,0);
 sub={id:'sub_billing',livemode:false,customer:'cus_billing',status:'active',cancel_at_period_end:false,metadata:{membershipBillingId:row.id},items:{data:[{quantity:1,current_period_end:Date.parse('2030-02-01')/1000,price:{unit_amount:5000,currency:'usd',recurring:{interval:'month',interval_count:1}}}]}};
 invoice={id:'in_first',livemode:false,status:'paid',currency:'usd',customer:'cus_billing',amount_paid:5000,billing_reason:'subscription_create',parent:{subscription_details:{subscription:sub.id}},lines:{has_more:false,data:[{amount:5000,period:{start:Date.parse('2030-01-01')/1000,end:Date.parse('2030-02-01')/1000}}]}};
});
test('checkout is not access; verified paid invoice issues membership and one receipt across duplicate events',async()=>{
 await service.webhook(event('evt_checkout','checkout.session.completed',{subscription:sub.id}));
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,0);
 await service.webhook(event('evt_paid','invoice.paid',invoice));
 await service.webhook(event('evt_paid','invoice.paid',invoice));
 await service.webhook(event('evt_paid_again','invoice.paid',invoice));
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,1);
 assert.equal((await pool.query("SELECT * FROM app_notification_outbox WHERE dedupe_key='membership-receipt:in_first'")).rowCount,1);
 assert.equal((await pool.query("SELECT * FROM payment WHERE reference='in_first' AND paymentstatus='paid'")).rowCount,1);
});
test('failed renewal does not extend access; later paid renewal grants exactly the next period',async()=>{
 sub.status='past_due';
 const failed={...invoice,id:'in_renewal'};
 await service.webhook(event('evt_failed','invoice.payment_failed',failed));
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,1);
 assert.equal((await pool.query("SELECT * FROM app_notification_outbox WHERE dedupe_key='membership-failed:in_renewal'")).rowCount,1);
 sub.status='active';
 invoice={...invoice,id:'in_renewal',billing_reason:'subscription_cycle',lines:{has_more:false,data:[{amount:5000,period:{start:Date.parse('2030-02-01')/1000,end:Date.parse('2030-03-01')/1000}}]}};
 await service.webhook(event('evt_renewed','invoice.paid',invoice));
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,2);
});
test('ownership, cancellation and out-of-order subscription event preserve cancellation; paid periods remain',async()=>{
 await assert.rejects(service.cancel(other,row.id),{code:'NOT_FOUND'});
 await assert.rejects(service.portal(other,row.id),{code:'NOT_FOUND'});
 await service.cancel(userid,row.id);
 await service.webhook(event('evt_late','customer.subscription.updated',{...sub,cancel_at_period_end:false}));
 assert.equal((await service.mine(userid))[0].cancelAtPeriodEnd,true);
 assert.equal((await pool.query('SELECT * FROM app_membership_invoice')).rowCount,2);
});
test('reject live events and invoice/customer/amount mismatches without recording success',async()=>{
 await assert.rejects(service.webhook({...event('evt_live','invoice.paid',invoice),livemode:true}),{code:'LIVE_PAYMENT_FORBIDDEN'});
 const original=invoice;
 invoice={...invoice,id:'in_wrong',customer:'cus_wrong'};
 await assert.rejects(service.webhook(event('evt_wrong','invoice.paid',invoice)),{code:'PAYMENT_MISMATCH'});
 assert.equal((await pool.query("SELECT * FROM app_membership_stripe_event WHERE id='evt_wrong'")).rowCount,0);
 invoice=original;
});
test('webhook route rejects unsigned calls and billing routes require login',async()=>{
 const app=createApp(pool,{port:8080,host:'127.0.0.1',demoLogin:false,secureCookies:false,timeZone:'America/New_York',jwtKey:new Uint8Array(randomBytes(32)),allowedOrigins:['http://localhost'],studioStripe:provider.config});
 await request(app).post('/api/webhooks/stripe-studios').send({id:'fake'}).expect(400);
 await request(app).get('/api/me/billing').expect(401);
});

test('staff original-card refund is idempotent; pending is not confirmed and members cannot refund',async()=>{
 const id='in_first';let calls=0;let refunds:any[]=[];
 (provider.sdk.invoicePayments.list as any)=async()=>({has_more:false,data:[{livemode:false,currency:'usd',amount_paid:5000,payment:{type:'payment_intent',payment_intent:'pi_membership'}}]});
 (provider.sdk.refunds.list as any)=async()=>({has_more:false,data:refunds});
 (provider.sdk.refunds.create as any)=async(p:any)=>{calls++;assert.equal(p.payment_intent,'pi_membership');refunds=[{id:'re_membership',currency:'usd',amount:5000,payment_intent:'pi_membership',status:'pending'}];return refunds[0];};
 (provider.sdk.refunds.retrieve as any)=async()=>refunds[0];
 await assert.rejects(service.refund(userid,id,'Member attempted refund'),{code:'STAFF_REQUIRED'});
 await service.refund(other,id,'Authorized test refund');
 assert.equal((await pool.query("SELECT paymentstatus FROM payment WHERE reference=$1",[id])).rows[0].paymentstatus,'paid');
 refunds[0].status='succeeded';
 await service.webhook(event('evt_refund','refund.updated',refunds[0]));
 await service.refund(other,id,'Repeat refund safely');
 assert.equal(calls,1);
 assert.equal((await pool.query("SELECT paymentstatus FROM payment WHERE reference=$1",[id])).rows[0].paymentstatus,'refunded');
 assert.equal((await pool.query("SELECT * FROM app_notification_outbox WHERE dedupe_key='membership-refund:in_first'")).rowCount,1);
});

test('concurrent duplicate deliveries issue exactly one period and receipt',async()=>{
 invoice={...invoice,id:'in_parallel',billing_reason:'subscription_cycle',lines:{has_more:false,data:[{amount:5000,period:{start:Date.parse('2030-03-01')/1000,end:Date.parse('2030-04-01')/1000}}]}};
 await Promise.all(Array.from({length:6},(_,n)=>service.webhook(event('evt_parallel_'+n,'invoice.paid',invoice))));
 assert.equal((await pool.query("SELECT * FROM app_membership_invoice WHERE id='in_parallel'")).rowCount,1);
 assert.equal((await pool.query("SELECT * FROM payment WHERE reference='in_parallel'")).rowCount,1);
 assert.equal((await pool.query("SELECT * FROM app_notification_outbox WHERE dedupe_key='membership-receipt:in_parallel'")).rowCount,1);
});

test('wrong quote, currency, subscription and overlapping period fail closed and remain retryable',async()=>{
 const good=invoice;
 for(const [label,patch] of Object.entries({amount:{amount_paid:1},currency:{currency:'eur'},subscription:{parent:{subscription_details:{subscription:'sub_other'}}},lines:{lines:{has_more:false,data:[{amount:1,period:good.lines.data[0].period}]}}})) {
  invoice={...good,...patch,id:'in_invalid_'+label};
  await assert.rejects(service.webhook(event('evt_invalid_'+label,'invoice.paid',{...invoice,parent:good.parent})),{code:'PAYMENT_MISMATCH'});
  assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',['evt_invalid_'+label])).rowCount,0);
 }
 invoice={...good,id:'in_overlap'};
 await assert.rejects(service.webhook(event('evt_overlap','invoice.paid',invoice)),{code:'MEMBERSHIP_OVERLAP'});
 assert.equal((await pool.query("SELECT id FROM app_membership_invoice WHERE id LIKE 'in_invalid_%' OR id='in_overlap'")).rowCount,0);
 invoice=good;
});

test('renewal notices deduplicate different event ids for the same upcoming period',async()=>{
 const upcoming={...invoice,period_end:Date.parse('2030-04-01')/1000};
 await service.webhook(event('evt_upcoming_1','invoice.upcoming',upcoming));
 await service.webhook(event('evt_upcoming_2','invoice.upcoming',upcoming));
 assert.equal((await pool.query('SELECT * FROM app_notification_outbox WHERE dedupe_key=$1',[`membership-renewal:${row.id}:${upcoming.period_end}`])).rowCount,1);
});
