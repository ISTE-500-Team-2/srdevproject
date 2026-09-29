import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {transaction} from '../../src/db.js';
import {StaffModel} from '../../src/models/StaffModel.js';
import {StaffService} from '../../src/services/StaffService.js';
import {MembershipBilling} from '../../src/billing/service.js';
import {PassBilling} from '../../src/billing/passes.js';
import {StudioService} from '../../src/studios/service.js';
import {StudioStripe} from '../../src/studios/stripe.js';
const database='arbor_review_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});let created=false,member:number,admin:number,monthly:any,day:any;
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const billing=new MembershipBilling(pool,provider),passes=new PassBilling(pool,provider),studio=new StudioService(pool,'America/New_York',provider),staff=new StaffService(pool,'America/New_York');
const event=(type:string,obj:any)=>({id:'evt_'+randomUUID(),livemode:false,type,data:{object:obj}} as any);
let canonical:any,mappings:any[]=[],checkout:any;
(provider.sdk.refunds.retrieve as any)=async()=>canonical;
(provider.sdk.refunds.list as any)=async()=>({data:[],has_more:false});
(provider.sdk.invoicePayments.list as any)=async()=>({data:mappings,has_more:false});
(provider.sdk.checkout.sessions.retrieve as any)=async()=>checkout;
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 member=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0].userid;
 admin=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
 const model=new StaffModel(pool);
 monthly=await model.plan((await pool.query("SELECT tierid FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0].tierid);
 day=await model.plan((await pool.query("SELECT tierid FROM membership_tiers WHERE kind='day_pass' LIMIT 1")).rows[0].tierid);
 await pool.query('UPDATE membership_tiers SET allottedmonths=1 WHERE tierid=$1',[monthly.id]);monthly=await model.plan(monthly.id);
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});
async function invoiceFixture(label:string,month:number,bind=true){
 const model=new StaffModel(pool),id='in_'+label,pi='pi_'+label,bid=randomUUID(),from=new Date(Date.UTC(2032,month,1)),to=new Date(Date.UTC(2032,month+1,1));
 const m=await model.createMembership(member,monthly,from.toISOString(),to,admin,'Refund fixture');
 const payment=await model.createPayment(member,m,'50.00','paid','card',id,'Refund fixture',admin);
 await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id) VALUES($1,$2,$3,$4,5000,'canceled',$5,$6)",[bid,member,monthly.id,monthly,'cus_'+label,'sub_'+label]);
 await pool.query('INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end,payment_intent) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,bid,m,payment,from,to,bind?pi:null]);
 return {id,pi,payment};
}
test('failed delayed studio payment releases dates and duplicate/stale events do not restore the hold',async()=>{
 const r=(await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,request_key,checkout_id,hold_until)
 VALUES(1,$1,'2032-01-01','2032-02-01',20000,'full_before_start','pending','stripe_test','unpaid',$2,'cs_delayed',now()+interval '1 hour') RETURNING *`,[member,randomUUID()])).rows[0];
 checkout={id:r.checkout_id,livemode:false,status:'complete',mode:'payment',payment_status:'unpaid',amount_total:20000,currency:'usd',client_reference_id:String(r.id),metadata:{studioRentalId:String(r.id)},payment_intent:'pi_delayed'};
 await studio.webhook(event('checkout.session.async_payment_failed',checkout));
 await studio.webhook(event('checkout.session.async_payment_failed',checkout));
 await studio.webhook(event('checkout.session.completed',checkout));
 assert.equal((await pool.query('SELECT status FROM app_studio_rental WHERE id=$1',[r.id])).rows[0].status,'expired');
 // The exclusion constraint must actually allow the same dates to be reserved.
 await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,request_key,hold_until)
 VALUES(1,$1,'2032-01-01','2032-02-01',20000,'full_before_start','pending','manual','unpaid',$2,now()+interval '1 hour')`,[member,randomUUID()]);
});
test('dashboard refund discovers original invoice payment without prior app refund request',async()=>{
 const r=await invoiceFixture('dashboard',1,false);
 mappings=[{livemode:false,status:'paid',currency:'usd',amount_paid:5000,invoice:r.id,payment:{type:'payment_intent',payment_intent:r.pi}}];
 canonical={id:'re_dashboard',livemode:false,status:'succeeded',payment_intent:r.pi,amount:5000,currency:'usd'};
 await billing.webhook(event('refund.created',canonical));
 const stored=(await pool.query('SELECT * FROM app_membership_invoice WHERE id=$1',[r.id])).rows[0];
 assert.equal(stored.payment_intent,r.pi);assert.equal(stored.refund_status,'succeeded');
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[r.payment])).rows[0].paymentstatus,'refunded');
});
test('late membership refund failure corrects payment ledger; stale success stays failed',async()=>{
 const r=await invoiceFixture('late',2);
 canonical={id:'re_late',livemode:false,status:'succeeded',payment_intent:r.pi,amount:5000,currency:'usd'};
 await billing.webhook(event('refund.updated',canonical));
 const stale={...canonical};canonical={...canonical,status:'failed'};
 await billing.webhook(event('refund.failed',canonical));await billing.webhook(event('refund.updated',stale));
 assert.equal((await pool.query('SELECT refund_status FROM app_membership_invoice WHERE id=$1',[r.id])).rows[0].refund_status,'failed');
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[r.payment])).rows[0].paymentstatus,'paid');
});
test('late day-pass refund failure corrects money status without restoring cancelled access',async()=>{
 const model=new StaffModel(pool),id=randomUUID(),pass=await model.createPass(member,day,'2032-06-01',admin,'Refund fixture');
 const payment=await model.createPayment(member,null,'15.00','paid','card','cs_late_pass','Refund fixture',admin);await model.linkPassPayment(pass,payment);
 await pool.query("INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,status,payment_intent,pass_id,payment_id) VALUES($1,$2,$3,'2032-06-01',$4,1500,'paid','pi_late_pass',$5,$6)",[id,member,day.id,day,pass,payment]);
 canonical={id:'re_late_pass',livemode:false,status:'succeeded',payment_intent:'pi_late_pass',amount:1500,currency:'usd'};
 await passes.webhook(event('refund.updated',canonical));const stale={...canonical};canonical={...canonical,status:'failed'};
 await passes.webhook(event('refund.failed',canonical));await passes.webhook(event('refund.updated',stale));
 assert.equal((await pool.query('SELECT refund_status FROM app_pass_checkout WHERE id=$1',[id])).rows[0].refund_status,'failed');
 assert.equal((await pool.query('SELECT paymentstatus FROM payment WHERE paymentid=$1',[payment])).rows[0].paymentstatus,'paid');
 assert.equal((await pool.query('SELECT status FROM day_pass WHERE dayid=$1',[pass])).rows[0].status,'cancelled');
});
for(const kind of ['membership','day_pass'] as const)test(`concurrent staff and online ${kind} issuance cannot create duplicate access`,async()=>{
 const plan=kind==='membership'?monthly:day,date='2035-01-01',model=new StaffModel(pool);
 // Pause the online path after its overlap check, while it holds the per-member lock.
 const method=kind==='membership'?'createMembership':'createPass',original=StaffModel.prototype[method];
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 (StaffModel.prototype as any)[method]=async function(...args:any[]){if(args[kind==='membership'?4:3]===member){entered();await gate;}return (original as any).apply(this,args);};
 const bid=randomUUID();let online:Promise<any>;
 if(kind==='membership'){
  await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id) VALUES($1,$2,$3,$4,5000,'canceled','cus_race','sub_race')",[bid,member,monthly.id,monthly]);
  const row=(await pool.query('SELECT * FROM app_membership_billing WHERE id=$1',[bid])).rows[0];
  const inv:any={id:'in_race',livemode:false,status:'paid',currency:'usd',amount_paid:5000,customer:'cus_race',parent:{subscription_details:{subscription:'sub_race'}},billing_reason:'subscription_create',lines:{has_more:false,data:[{amount:5000,period:{start:Date.parse(date)/1000,end:Date.parse('2035-02-01')/1000}}]}};
  online=transaction(pool,db=>billing.invoicePaid(db,inv,row));
 }else{
  await pool.query("INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents,checkout_id) VALUES($1,$2,$3,$4,$5,1500,'cs_race_pass')",[bid,member,day.id,date,day]);
  checkout={id:'cs_race_pass',livemode:false,status:'complete',mode:'payment',payment_status:'paid',amount_total:1500,currency:'usd',client_reference_id:bid,metadata:{dayPassCheckoutId:bid},payment_intent:'pi_race_pass'};
  online=passes.webhook(event('checkout.session.completed',checkout));
 }
 try{
  await ready;let settled=false;
  const manual=staff.issue(admin,member,{requestId:randomUUID(),planId:plan.id,startsAt:kind==='membership'?date+'T00:00:00Z':null,validDate:kind==='day_pass'?date:null,paymentStatus:'paid',method:'cash',reference:'CASH-RACE',reason:'Concurrent staff issuance'}).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  for(let i=0;i<100&&!settled;i++){
   const waiting=await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=7121 AND objid=$1 AND NOT granted",[member]);
   if(waiting.rowCount)break;await new Promise(r=>setTimeout(r,10));
  }
  release();await online;const result=await manual;
  assert.ok('error' in result,'staff must reject overlapping online issuance');
  assert.equal(result.error.code,kind==='membership'?'MEMBERSHIP_OVERLAP':'PASS_EXISTS');
  const count=kind==='membership'?await pool.query("SELECT count(*)::int n FROM user_membership WHERE userid=$1 AND startdate='2035-01-01'",[member]):await pool.query("SELECT count(*)::int n FROM day_pass WHERE userid=$1 AND validdate::date='2035-01-01'",[member]);
  assert.equal(count.rows[0].n,1);
 }finally{release();(StaffModel.prototype as any)[method]=original;await online.catch(()=>{});}
});

test('studio reconciliation preserves processing holds and releases confirmed failures without a webhook',async()=>{
 const r=(await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,request_key,checkout_id)
 VALUES(2,$1,'2032-01-01','2032-02-01',20000,'full_before_start','pending','stripe_test','unpaid',$2,'cs_sync_failure') RETURNING *`,[member,randomUUID()])).rows[0];
 checkout={id:r.checkout_id,livemode:false,status:'complete',mode:'payment',payment_status:'unpaid',amount_total:20000,currency:'usd',client_reference_id:String(r.id),metadata:{studioRentalId:String(r.id)},payment_intent:'pi_sync_failure'};
 let intent:any={id:'pi_sync_failure',livemode:false,amount:20000,currency:'usd',status:'processing'};
 (provider.sdk.paymentIntents.retrieve as any)=async()=>intent;
 assert.equal((await studio.syncPayment(member,r.id)).status,'pending');
 intent={...intent,status:'requires_payment_method',last_payment_error:{code:'payment_failed'}};
 assert.equal((await studio.syncPayment(member,r.id)).status,'expired');
});
test('stale studio failure cannot expire an already-paid checkout',async()=>{
 const r=(await pool.query(`INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,status,payment_method,payment_status,request_key,checkout_id)
 VALUES(3,$1,'2032-01-01','2032-02-01',20000,'full_before_start','pending','stripe_test','unpaid',$2,'cs_stale_failure') RETURNING *`,[member,randomUUID()])).rows[0];
 checkout={id:r.checkout_id,livemode:false,status:'complete',mode:'payment',payment_status:'paid',amount_total:20000,currency:'usd',client_reference_id:String(r.id),metadata:{studioRentalId:String(r.id)},payment_intent:'pi_stale_failure'};
 await studio.webhook(event('checkout.session.async_payment_failed',{...checkout,payment_status:'unpaid'}));
 const stored=(await pool.query('SELECT status,payment_status FROM app_studio_rental WHERE id=$1',[r.id])).rows[0];
 assert.equal(stored.status,'confirmed');assert.equal(stored.payment_status,'paid');
});
test('mismatched dashboard invoice mapping is rejected and remains retryable',async()=>{
 const r=await invoiceFixture('wrong_mapping',8,false);
 mappings=[{livemode:false,status:'paid',currency:'usd',amount_paid:1,invoice:r.id,payment:{type:'payment_intent',payment_intent:r.pi}}];
 canonical={id:'re_wrong_mapping',status:'succeeded',payment_intent:r.pi,amount:5000,currency:'usd'};
 const e=event('refund.created',canonical);
 await assert.rejects(billing.webhook(e),{code:'RECONCILE_REQUIRED'});
 assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',[e.id])).rowCount,0);
 assert.equal((await pool.query('SELECT payment_intent FROM app_membership_invoice WHERE id=$1',[r.id])).rows[0].payment_intent,null);
});
test('refund before invoice persistence is retried, not silently acknowledged',async()=>{
 const bid=randomUUID(),pi='pi_early_invoice';
 await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,subscription_id) VALUES($1,$2,$3,$4,5000,'canceled','sub_early_invoice')",[bid,member,monthly.id,monthly]);
 mappings=[{livemode:false,status:'paid',currency:'usd',amount_paid:5000,invoice:'in_early_invoice',payment:{type:'payment_intent',payment_intent:pi}}];
 (provider.sdk.invoices.retrieve as any)=async()=>({parent:{subscription_details:{subscription:'sub_early_invoice'}}});
 const e=event('refund.updated',{id:'re_early_invoice',payment_intent:pi});
 await assert.rejects(billing.webhook(e),{code:'INVOICE_PENDING'});
 assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',[e.id])).rowCount,0);
});

test('refund before subscription binding remains retryable and replay corrects the later invoice',async()=>{
 const bid=randomUUID(),pi='pi_before_binding',sid='sub_before_binding',iid='in_before_binding';
 await pool.query('INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents) VALUES($1,$2,$3,$4,5000)',[bid,member,monthly.id,monthly]);
 const start=Date.parse('2036-01-01')/1000,end=Date.parse('2036-02-01')/1000;
 const sub:any={id:sid,livemode:false,metadata:{membershipBillingId:bid},customer:'cus_before_binding',status:'canceled',cancel_at_period_end:false,items:{data:[{quantity:1,current_period_end:end,price:{currency:'usd',unit_amount:5000,recurring:{interval:'month',interval_count:1}}}]}};
 const inv:any={id:iid,livemode:false,status:'paid',currency:'usd',amount_paid:5000,customer:sub.customer,parent:{subscription_details:{subscription:sid}},billing_reason:'subscription_create',lines:{has_more:false,data:[{amount:5000,period:{start,end}}]}};
 mappings=[{livemode:false,status:'paid',currency:'usd',amount_paid:5000,invoice:iid,payment:{type:'payment_intent',payment_intent:pi}}];
 (provider.sdk.invoices.retrieve as any)=async()=>inv;
 (provider.sdk.subscriptions.retrieve as any)=async()=>sub;
 canonical={id:'re_before_binding',status:'succeeded',payment_intent:pi,amount:5000,currency:'usd'};
 const refundEvent=event('refund.created',canonical);
 await assert.rejects(billing.webhook(refundEvent),{code:'INVOICE_PENDING'});
 assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',[refundEvent.id])).rowCount,0);
 await billing.webhook(event('invoice.paid',inv));
 await billing.webhook(refundEvent);await billing.webhook(refundEvent);
 const row=(await pool.query('SELECT i.refund_status,p.paymentstatus FROM app_membership_invoice i JOIN payment p ON p.paymentid=i.payment_id WHERE i.id=$1',[iid])).rows[0];
 assert.equal(row.refund_status,'succeeded');assert.equal(row.paymentstatus,'refunded');
 assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',[refundEvent.id])).rowCount,1);
});

test('unrelated subscription refund is acknowledged without blocking other products',async()=>{
 mappings=[{invoice:'in_unrelated'}];
 (provider.sdk.invoices.retrieve as any)=async()=>({parent:{subscription_details:{subscription:'sub_unrelated'}}});
 (provider.sdk.subscriptions.retrieve as any)=async()=>({id:'sub_unrelated',metadata:{},livemode:false});
 const e=event('refund.created',{id:'re_unrelated',payment_intent:'pi_unrelated'});
 await billing.webhook(e);
 assert.equal((await pool.query('SELECT id FROM app_membership_stripe_event WHERE id=$1',[e.id])).rowCount,1);
});
