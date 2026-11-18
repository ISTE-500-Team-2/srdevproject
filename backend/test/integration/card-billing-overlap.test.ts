import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import type Stripe from 'stripe';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {MembershipBilling,type MembershipCheckoutRequest} from '../../src/billing/service.js';
import {StudioStripe} from '../../src/studios/stripe.js';
import {StaffModel,type Plan} from '../../src/models/StaffModel.js';
import {OVERLAPPING_CARD_PAYMENT_NOTE} from '../../src/models/staff/payments.js';
import {UserModel} from '../../src/models/UserModel.js';
import {StaffService} from '../../src/services/StaffService.js';
import {stripeEvent,stripeMock,type StripeFixture} from '../helpers/stripeFixtures.js';

// Card membership billing and desk sales must never charge twice for the same dates without a
// record, and one failed Stripe call must never block a member for good.
const database='arbor_card_overlap_'+randomBytes(5).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database}),zone='America/New_York';
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const billing=new MembershipBilling(pool,provider),staff=new StaffService(pool,zone),stripe=stripeMock(provider);
let created=false,admin:number,plan:Plan,people=0;
let sub:StripeFixture<Stripe.Subscription>,invoice:StripeFixture<Stripe.Invoice>;
const openSession=async(params?:Stripe.Checkout.SessionCreateParams)=>({id:'cs_'+params!.client_reference_id,livemode:false,status:'open' as const,url:'https://checkout.stripe.com/test'});
stripe.checkoutSessionCreate(openSession);
stripe.checkoutSessionRetrieve(async id=>({id,livemode:false,status:'open',url:'https://checkout.stripe.com/test'}));
stripe.subscriptionRetrieve(async()=>sub);
stripe.invoiceRetrieve(async()=>invoice);
before(async()=>{
 if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Isolated PostgreSQL required');
 await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
 admin=(await pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
 const id=(await pool.query("SELECT tierid FROM membership_tiers WHERE kind='membership' LIMIT 1")).rows[0].tierid;
 await pool.query('UPDATE membership_tiers SET allottedmonths=1,tierprice=50,active=true WHERE tierid=$1',[id]);
 plan=(await new StaffModel(pool,zone).plan(id))!;
});
after(async()=>{await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();});

async function person(role?:'staff') {
 const n=++people,id=await new UserModel(pool).create({firstName:'Card'+n,lastName:'Overlap',email:`card-overlap-${n}@example.invalid`,
  phone:'555-0100',password:'unused-test-credential',dob:'1990-01-01'});
 if(role)await pool.query("INSERT INTO user_role(userid,roleid,assignedat) SELECT $1,roleid,NOW() AT TIME ZONE 'UTC' FROM role WHERE role=$2",[id,role]);
 return id;
}
const monthly=():MembershipCheckoutRequest=>({planId:plan.id,expectedRevision:plan.revision,autoRenewConsent:true});
const desk=(userId:number,startsAt:string)=>staff.issue(admin,userId,{requestId:randomUUID(),planId:plan.id,startsAt,validDate:null,
 paymentStatus:'paid',method:'cash',reference:'CASH',reason:'Desk sale test'});
const issued=async(sale:ReturnType<typeof desk>)=>{const result=await sale;return 'kind' in result?result.kind:undefined;};
const billingRows=async(userId:number)=>(await pool.query<{id:string;status:string;checkout_id:string|null}>(
 'SELECT id,status,checkout_id FROM app_membership_billing WHERE userid=$1 ORDER BY created_at',[userId])).rows;

test('a desk membership is refused while a card checkout or renewing subscription could charge the same dates',async()=>{
 const member=await person(),start=new Date(Date.now()+60_000).toISOString();
 await billing.checkout(member,monthly());
 await assert.rejects(desk(member,start),{code:'CARD_BILLING_ACTIVE',message:/checkout in progress/});
 await pool.query("UPDATE app_membership_billing SET status='active',subscription_id='sub_desk',customer_id='cus_desk' WHERE userid=$1",[member]);
 await assert.rejects(desk(member,start),{code:'CARD_BILLING_ACTIVE',message:/pays monthly by card/});
 // Renewal is being turned off: a desk membership may start when card billing ends, once Stripe confirms it.
 const ends=new Date(Date.now()+40*86400_000);
 await pool.query('UPDATE app_membership_billing SET cancellation_effective_at=$2 WHERE userid=$1',[member,ends]);
 await assert.rejects(desk(member,ends.toISOString()),{code:'CARD_BILLING_ACTIVE'});
 await pool.query('UPDATE app_membership_billing SET cancellation_confirmed=true WHERE userid=$1',[member]);
 await assert.rejects(desk(member,start),{code:'CARD_BILLING_ACTIVE'});
 assert.equal(await issued(desk(member,ends.toISOString())),'membership');
});

test('a card charge for dates a desk membership already covers is recorded and flagged, never lost',async()=>{
 const member=await person(),model=new StaffModel(pool,zone),bid=randomUUID();
 const from=Date.parse('2031-03-01T00:00:00Z')/1000,to=Date.parse('2031-04-01T00:00:00Z')/1000;
 await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id) VALUES($1,$2,$3,$4,5000,'active','cus_overlap','sub_overlap')",[bid,member,plan.id,plan]);
 const sold=await model.createMembership(member,plan,new Date(from*1000).toISOString(),new Date(to*1000),admin,'Desk sale');
 const deskPayment=await model.createPayment(member,sold,'50.00','paid','cash','CASH','Desk sale',admin);
 sub={billing_cycle_anchor:from,id:'sub_overlap',livemode:false,customer:'cus_overlap',status:'active',cancel_at_period_end:false,metadata:{},
  items:{data:[{quantity:1,current_period_end:to,price:{unit_amount:5000,currency:'usd',recurring:{interval:'month',interval_count:1}}}]}};
 invoice={id:'in_overlap',livemode:false,status:'paid',currency:'usd',customer:'cus_overlap',amount_paid:5000,billing_reason:'subscription_cycle',
  parent:{subscription_details:{subscription:'sub_overlap'}},lines:{has_more:false,data:[{amount:5000,period:{start:from,end:to}}]}};
 await billing.webhook(stripeEvent('evt_overlap','invoice.paid',invoice));
 // Acknowledged, so Stripe stops retrying, and the money is on record.
 assert.equal((await pool.query("SELECT 1 FROM app_membership_stripe_event WHERE id='evt_overlap'")).rowCount,1);
 const recorded=(await pool.query(`SELECT i.membership_id,p.paymentstatus,p.method,p.note FROM app_membership_invoice i
  JOIN payment p ON p.paymentid=i.payment_id WHERE i.id='in_overlap'`)).rows[0];
 assert.equal(recorded.paymentstatus,'paid');assert.equal(recorded.method,'card');
 assert.equal(recorded.note,OVERLAPPING_CARD_PAYMENT_NOTE);assert.notEqual(recorded.membership_id,sold);
 const listed=async(viewer?:'staff')=>(await model.payments(member,0,{},viewer)).find(p=>p.invoiceId==='in_overlap')!.planName;
 assert.match(await listed('staff'),/check for a double charge/);
 // The member's own history gets member wording, not the staff instruction.
 assert.match(await listed(),/may overlap another membership; ask staff/);
 assert.doesNotMatch(await listed(),/double charge/);
 const receipt=(await pool.query("SELECT payload FROM app_notification_outbox WHERE dedupe_key='membership-receipt:in_overlap'")).rows[0].payload;
 assert.match(receipt.instructions,/paid twice/);
 const audit=(await pool.query("SELECT after_state FROM app_staff_audit WHERE action='billing.membership_overlap_flagged' AND subject_id=$1",[member])).rows[0];
 assert.deepEqual(audit.after_state.overlaps,[sold]);
 // A repeat delivery changes nothing. Refunding or voiding either charge clears the flag.
 await billing.webhook(stripeEvent('evt_overlap_again','invoice.paid',invoice));
 assert.equal((await pool.query("SELECT 1 FROM payment WHERE reference='in_overlap'")).rowCount,1);
 const deskStatus=(status:string)=>pool.query('UPDATE payment SET paymentstatus=$2 WHERE paymentid=$1',[deskPayment,status]);
 await deskStatus('refunded');
 assert.doesNotMatch(await listed('staff'),/double charge/);
 await deskStatus('void');
 assert.doesNotMatch(await listed('staff'),/double charge/);
 await deskStatus('paid');
 assert.match(await listed('staff'),/double charge/);
 await pool.query("UPDATE payment SET paymentstatus='refunded' WHERE reference='in_overlap'");
 assert.doesNotMatch(await listed('staff'),/double charge/);
});

test('resuming an old checkout is refused once a membership covers the member',async()=>{
 const member=await person();
 await billing.checkout(member,monthly());
 await new StaffModel(pool,zone).createMembership(member,plan,new Date().toISOString(),new Date(Date.now()+30*86400_000),admin,'Issued meanwhile');
 await assert.rejects(billing.checkout(member,monthly()),{code:'MEMBERSHIP_EXISTS'});
});

test('a checkout whose first Stripe call failed is abandoned after a day instead of blocking the member for good',async()=>{
 const member=await person();
 stripe.checkoutSessionCreate(async()=>{throw new Error('Stripe timed out');});
 try{await assert.rejects(billing.checkout(member,monthly()),/Stripe timed out/);}
 finally{stripe.checkoutSessionCreate(openSession);}
 const [stuck]=await billingRows(member);
 assert.equal(stuck!.checkout_id,null);
 // Within a day the same checkout is resumed (Stripe's idempotency covers the retry), not replaced.
 await assert.rejects(billing.cancel(member,stuck!.id),{code:'RECONCILE_REQUIRED'});
 await pool.query("UPDATE app_membership_billing SET created_at=now()-interval '23 hours 30 minutes' WHERE id=$1",[stuck!.id]);
 await assert.rejects(billing.checkout(member,monthly()),{code:'RECONCILE_REQUIRED',message:/Try again in an hour/});
 await pool.query("UPDATE app_membership_billing SET created_at=now()-interval '25 hours' WHERE id=$1",[stuck!.id]);
 assert.ok((await billing.checkout(member,monthly())).checkoutUrl);
 const rows=await billingRows(member);
 assert.deepEqual(rows.map(r=>r.status),['expired','pending']);
 assert.ok(rows[1]!.checkout_id);
 // An abandoned checkout can also be cancelled, and no longer blocks a desk sale.
 const abandoned=async()=>{
  const userId=await person(),id=randomUUID();
  await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,created_at) VALUES($1,$2,$3,$4,5000,now()-interval '25 hours')",[id,userId,plan.id,plan]);
  return {userId,id};
 };
 const cancelled=await abandoned();
 await billing.cancel(cancelled.userId,cancelled.id);
 assert.deepEqual((await billingRows(cancelled.userId)).map(r=>r.status),['expired']);
 const sold=await abandoned();
 assert.equal(await issued(desk(sold.userId,new Date(Date.now()+60_000).toISOString())),'membership');
 assert.deepEqual((await billingRows(sold.userId)).map(r=>r.status),['expired']);
});

test('staff cannot refund their own card payment, and only administrators refund staff accounts',async()=>{
 const deskStaff=await person('staff'),colleague=await person('staff'),model=new StaffModel(pool,zone);
 let refunds=0;
 stripe.refundList(async()=>({has_more:false,data:[]}));
 stripe.refundCreate(async p=>{refunds++;return {id:'re_'+refunds,currency:'usd',amount:p!.amount!,payment_intent:p!.payment_intent as string,status:'pending'};});
 const paid=async(userId:number,label:string,month:number)=>{
  const id='in_'+label,bid=randomUUID(),from=new Date(Date.UTC(2032,month,1)),to=new Date(Date.UTC(2032,month+1,1));
  const membership=await model.createMembership(userId,plan,from.toISOString(),to,admin,'Refund fixture');
  const payment=await model.createPayment(userId,membership,'50.00','paid','card',id,'Refund fixture',admin);
  await pool.query("INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents,status,customer_id,subscription_id) VALUES($1,$2,$3,$4,5000,'canceled',$5,$6)",[bid,userId,plan.id,plan,'cus_'+label,'sub_'+label]);
  await pool.query('INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end,payment_intent) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,bid,membership,payment,from,to,'pi_'+label]);
  return id;
 };
 const deskInvoice=await paid(deskStaff,'desk_staff',1),adminInvoice=await paid(admin,'admin_self',2);
 await assert.rejects(billing.refund(deskStaff,deskInvoice,'Refund my own month'),{code:'SELF_CHANGE_FORBIDDEN'});
 await assert.rejects(billing.refund(colleague,deskInvoice,'Refund a colleague'),{code:'ADMIN_REQUIRED'});
 await assert.rejects(billing.refund(admin,adminInvoice,'Refund my own month'),{code:'SELF_CHANGE_FORBIDDEN'});
 assert.equal(refunds,0);
 assert.deepEqual(await billing.refund(admin,deskInvoice,'Administrator refund'),{status:'pending'});
 assert.equal(refunds,1);
});
