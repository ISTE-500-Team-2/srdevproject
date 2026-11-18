// Coordinates day-pass checkout, issuance and cancellation, including separate handling for
// payments recorded at the desk.

import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {transaction,type Database} from '../db.js';
import {AppError,positiveId,textField} from '../domain.js';
import {calendarDate} from '../staffDomain.js';
import {StaffModel,type Plan} from '../models/StaffModel.js';
import {AccessService} from '../services/AccessService.js';
import {requireActor} from '../accountPolicy.js';
import {assertManageable} from '../services/StaffService.js';
import {businessToday} from '../businessDate.js';
import {StudioStripe} from '../studios/stripe.js';
import {enqueueNotification} from '../notifications/store.js';
import {quote} from './pricing.js';
import {failedRefund,liveRefund,refundAttempt,refundTransition,replacedAttemptFailed} from './refundTransition.js';
import {isCheckoutSessionEvent,isRefundEvent} from './stripeEvents.js';
import {expireAbandonedMembershipCheckouts} from './openBilling.js';
import {providerTransaction} from './providerGate.js';
/** An app_pass_checkout row. */
interface PassCheckoutRow {id:string;userid:number;tierid:number;valid_date:Date;plan_snapshot:Plan;amount_cents:number;
 status:'pending'|'paid'|'cancelled'|'expired';checkout_id:string|null;payment_intent:string|null;pass_id:number|null;payment_id:number|null;
 cancel_requested_at:Date|null;refund_id:string|null;refund_status:string|null;created_at:Date;}
/** Day-pass checkout request; each field is validated by PassBilling.checkout. */
export interface PassCheckoutRequest {[field:string]:unknown;validDate?:unknown;planId?:unknown;expectedRevision?:unknown;pricingRevision?:unknown;amountCents?:unknown;}
/** Free monthly membership request; each field is validated by PassBilling.freeMembership. */
export interface FreeMembershipRequest {[field:string]:unknown;planId?:unknown;expectedRevision?:unknown;pricingRevision?:unknown;}
const objectId=(v:string|{id:string}|null|undefined):string|undefined=>typeof v==='string'?v:v?.id;
/** Marks a payment that never became a pass (see recordUnissuedPayment), so the member isn't told about a pass. */
const unissued=(r:Pick<PassCheckoutRow,'pass_id'|'payment_id'>)=>r.payment_id&&!r.pass_id?{passIssued:false as const}:{};
// A checkout whose session was never stored: nobody got its payment link, and any session the failed
// call created expired with Stripe's 24-hour default. A day later it is abandoned, not pending.
const ABANDONED="status='pending' AND checkout_id IS NULL AND created_at<now()-interval '24 hours'";
export class PassBilling {
 constructor(readonly pool:Pool,readonly stripe?:StudioStripe,readonly zone='America/New_York'){}
 provider(){if(!this.stripe)throw new AppError(503,'PAYMENTS_UNAVAILABLE','Card checkout is not configured.');return this.stripe;}
 async mine(userid:number){
  // Staff can put an issued pass on hold or revoke it; show that, not the checkout's 'paid'.
  // cancelRequested: the member's own cancellation (or an unissued payment's refund) is recorded, so cancel()
  // retries a failed refund after the notice deadline; a staff refund isn't, so only staff retry it then.
  // passIssued is false for a card payment that never became a pass (see recordUnissuedPayment): only its refund remains.
  const online=(await this.pool.query(`SELECT c.id,c.plan_snapshot AS plan,to_char(c.valid_date,'YYYY-MM-DD') AS "validDate",c.amount_cents AS "amountCents",
  CASE WHEN c.status='paid' AND d.status IN ('suspended','revoked') THEN d.status ELSE c.status END AS status,c.refund_status AS "refundStatus",
  c.cancel_requested_at IS NOT NULL AS "cancelRequested",NOT (c.payment_id IS NOT NULL AND c.pass_id IS NULL) AS "passIssued",
  ((c.valid_date-3)::timestamp AT TIME ZONE $2) AS "cancelBy" FROM app_pass_checkout c LEFT JOIN day_pass d ON d.dayid=c.pass_id WHERE c.userid=$1 ORDER BY c.created_at DESC LIMIT 100`,[userid,this.zone])).rows;
  const manual=(await this.pool.query(`SELECT 'manual:'||d.dayid AS id,d.plan_snapshot AS plan,to_char(d.validdate,'YYYY-MM-DD') AS "validDate",round(COALESCE(p.price,0)*100)::int AS "amountCents",d.status,CASE WHEN p.paymentstatus='refunded' THEN 'succeeded' ELSE NULL END AS "refundStatus",
   false AS "cancelRequested",true AS "passIssued",
   ((d.validdate::date-3)::timestamp AT TIME ZONE $2) AS "cancelBy" FROM day_pass d LEFT JOIN payment p ON p.paymentid=d.paymentid
   WHERE d.userid=$1 AND NOT EXISTS(SELECT 1 FROM app_pass_checkout c WHERE c.pass_id=d.dayid) ORDER BY d.dayid DESC LIMIT 100`,[userid,this.zone])).rows;
  return [...online,...manual];}
 async cancelManual(userid:number,id:number){
  return transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   const r=(await db.query<{status:string;validdate:Date;paymentid:number|null;paymentstatus:string|null;timely:boolean}>(`SELECT d.*,p.paymentstatus,p.price,p.method,now()<=((d.validdate::date-3)::timestamp AT TIME ZONE $3) AS timely
    FROM day_pass d LEFT JOIN payment p ON p.paymentid=d.paymentid WHERE d.dayid=$1 AND d.userid=$2 FOR UPDATE OF d`,[id,userid,this.zone])).rows[0];
   if(!r)throw new AppError(404,'NOT_FOUND','Day pass not found.');
   if((await db.query('SELECT id FROM app_pass_checkout WHERE pass_id=$1',[id])).rowCount)throw new AppError(409,'PROVIDER_PAYMENT','Use the online checkout cancellation.');
   if(r.status==='cancelled')return {cancelled:true,manualRefundRequired:r.paymentstatus==='paid'};
   if(r.status!=='active')throw new AppError(409,'INVALID_STATUS','Contact staff about this pass.');
   if(!r.timely)throw new AppError(409,'CANCELLATION_NOTICE','Day passes require at least 3 days cancellation notice.');
   await db.query("UPDATE day_pass SET status='cancelled',statusdesc='Member cancellation with 3 days notice',revision=revision+1 WHERE dayid=$1",[id]);
   await new StaffModel(db).audit(userid,userid,'daypass.cancelled','day_pass',id,'Timely member cancellation',null,{manualRefundRequired:r.paymentstatus==='paid',paymentId:r.paymentid});
   await enqueueNotification(db,{userId:userid,kind:'reservation_cancelled',dedupeKey:'manual-daypass-cancel:'+id,payload:{validDate:new Date(r.validdate).toISOString().slice(0,10),paymentId:r.paymentid,instructions:r.paymentstatus==='paid'?'Contact staff to complete the refund through the original cash/card payment method. Your pass is cancelled; no refund has been recorded yet.':'Your pass is cancelled.'}});
   return {cancelled:true,manualRefundRequired:r.paymentstatus==='paid'};
  });
 }
 // Card subscriptions stop through Stripe; everything else (desk-paid, free access) stops here.
 async cancelMembership(userid:number,id:number){
  return transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   // Staff status changes lock the member before the entitlement. Audit writes
   // also need the member's FK lock, so keep the same order here.
   await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[userid]);
   const r=(await db.query<{status:string;cancellation_requested_at:Date|null;plan_name:string;ends:Date;running:boolean}>(`SELECT m.status,m.cancellation_requested_at,COALESCE(m.plan_snapshot->>'name',t.tiername,'Membership') AS plan_name,m.end_date AT TIME ZONE 'UTC' AS ends,
    m.startdate<=NOW() AT TIME ZONE 'UTC' AND m.end_date>NOW() AT TIME ZONE 'UTC' AS running
    FROM user_membership m LEFT JOIN membership_tiers t USING(tierid) WHERE m.membershipid=$1 AND m.userid=$2 FOR UPDATE OF m`,[id,userid])).rows[0];
   if(!r)throw new AppError(404,'NOT_FOUND','Membership not found.');
   if((await db.query('SELECT id FROM app_membership_invoice WHERE membership_id=$1',[id])).rowCount)throw new AppError(409,'PROVIDER_PAYMENT','Stop auto-renew to cancel a card membership.');
   if(r.cancellation_requested_at)return {cancelled:true,endsAt:r.ends};
   if(r.status!=='active'||!r.running)throw new AppError(409,'INVALID_STATUS','Contact staff about this membership.');
   const ends=(await db.query<{ends:Date}>(`UPDATE user_membership SET end_date=LEAST(end_date,(NOW() AT TIME ZONE 'UTC')+INTERVAL '30 days'),
    cancellation_requested_at=NOW(),revision=revision+1 WHERE membershipid=$1 RETURNING end_date AT TIME ZONE 'UTC' AS ends`,[id])).rows[0]!.ends;
   await new StaffModel(db).audit(userid,userid,'membership.cancelled','membership',id,'Member cancellation with 30 days notice',{endsAt:r.ends},{endsAt:ends});
   await enqueueNotification(db,{userId:userid,kind:'membership_cancellation_confirmed',dedupeKey:'membership-manual-cancel:'+id,
    payload:{membershipId:id,membershipName:r.plan_name,endsAt:new Date(ends).toISOString(),instructions:'If you paid at the front desk, ask staff about any refund.'}});
   return {cancelled:true,endsAt:ends};
  });
 }
 async checkout(userid:number,body:PassCheckoutRequest){
  const returnPath = `/checkout-return?member=${userid}`;
  const date=calendarDate(body.validDate),id=positiveId(body.planId);
  const row=await transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   const user=await requireActor(db,userid),model=new StaffModel(db,this.zone);
   await new AccessService(db,this.zone).assertWaivers(userid);
   if(date<businessToday(this.zone))throw new AppError(400,'INVALID_DATE','Choose today or a future date.');
   const plan=await model.plan(id,true);
   if(!plan?.active||plan.kind!=='day_pass')throw new AppError(400,'INVALID_PLAN','Choose an active day-pass plan.');
   const offer=await quote(db,userid,plan,date);
   if(body.expectedRevision!==plan.revision||body.pricingRevision!==offer.pricingRevision||body.amountCents!==offer.amountCents)throw new AppError(409,'PRICE_CHANGED','Refresh and review the current price.');
   await db.query(`UPDATE app_pass_checkout SET status='expired' WHERE userid=$1 AND valid_date=$2 AND ${ABANDONED}`,[userid,date]);
   const old=(await db.query<PassCheckoutRow>("SELECT * FROM app_pass_checkout WHERE userid=$1 AND valid_date=$2 AND status NOT IN ('expired','cancelled') FOR UPDATE",[userid,date])).rows[0];
   if(old){if(old.tierid!==id||old.amount_cents!==offer.amountCents)throw new AppError(409,'CHECKOUT_EXISTS','Cancel the existing checkout before changing plans.');return {...old,email:user.email};}
   if(await model.passExists(userid,date))throw new AppError(409,'PASS_EXISTS','You already have a pass for this date.');
   if(offer.amountCents>0)this.provider();
   const r=(await db.query<PassCheckoutRow>(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),userid,id,date,JSON.stringify({...plan,price:(offer.amountCents/100).toFixed(2),priceBasis:offer.basis}),offer.amountCents])).rows[0]!;
   if(r.amount_cents===0)await this.issue(db,r,'free:'+r.id);
   return {...r,email:user.email};
  });
  if(row.amount_cents===0)return {issued:true};
  if(row.status!=='pending')throw new AppError(409,'PASS_EXISTS','This pass is already issued or cancelled. Refresh its status.');
  if(!row.checkout_id&&Date.now()-new Date(row.created_at).getTime()>23*3600000)throw new AppError(409,'RECONCILE_REQUIRED','This checkout can no longer be resumed. Try again in an hour to start a new one.');
  // Stop taking payment when the visit date ends, so a late payment can't buy a day that is over.
  const p=this.provider(),payBy=row.checkout_id?null:await new StaffModel(this.pool,this.zone).passCheckoutPayBy(row.id);
  if(payBy&&payBy.getTime()-Date.now()<31*60000){
   // Stripe needs 30 minutes; a checkout that never got a session can't have been paid, so start over.
   await this.pool.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND checkout_id IS NULL",[row.id]);
   throw new AppError(409,'CHECKOUT_EXPIRED','Checkout expired. Refresh and try again.');
  }
  const s=row.checkout_id?await p.sdk.checkout.sessions.retrieve(row.checkout_id):await p.sdk.checkout.sessions.create({mode:'payment',payment_method_types:['card'],client_reference_id:row.id,customer_email:row.email,
   metadata:{dayPassCheckoutId:row.id},success_url:p.config.origin+returnPath+(returnPath.includes('?')?'&':'?')+'pass=returned&checkout='+row.id,cancel_url:p.config.origin+returnPath+(returnPath.includes('?')?'&':'?')+'pass=cancelled',
   expires_at:Math.floor(payBy!.getTime()/1000),
   payment_intent_data:{metadata:{dayPassCheckoutId:row.id}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:row.amount_cents,product_data:{name:row.plan_snapshot.name}}}]},{idempotencyKey:'daypass-checkout:'+row.id});
  if(s.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test payments only.');
  await this.pool.query('UPDATE app_pass_checkout SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL',[row.id,s.id]);
  if(s.status==='expired'){await this.pool.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending'",[row.id]);throw new AppError(409,'CHECKOUT_EXPIRED','Checkout expired. Refresh and try again.');}
  if(s.status!=='open'||!s.url)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
  return {checkoutUrl:s.url};
 }
 async issue(db:Database,r:PassCheckoutRow,reference:string){
  // A payment without a pass was recorded for refund (see recordUnissuedPayment).
  if(r.pass_id||r.payment_id)return;
  const model=new StaffModel(db,this.zone),date=new Date(r.valid_date).toISOString().slice(0,10);
  if(await model.passExists(r.userid,date))throw new AppError(409,'PASS_EXISTS','An existing pass requires payment reconciliation.');
  const pass=await model.createPass(r.userid,r.plan_snapshot,date,r.userid,'Online day pass');
  const payment=await model.createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),r.amount_cents?'paid':'waived',r.amount_cents?'card':'none',reference,'Online day pass',r.userid);
  await model.linkPassPayment(pass,payment);
  await db.query("UPDATE app_pass_checkout SET pass_id=$2,payment_id=$3,status='paid' WHERE id=$1",[r.id,pass,payment]);
  await model.audit(r.userid,r.userid,'daypass.issued','day_pass',pass,'Online day pass',null,{payment,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_receipt',dedupeKey:'daypass-receipt:'+r.id,payload:{amount:(r.amount_cents/100).toFixed(2),currency:'USD',reference,method:r.amount_cents?'Card (test mode)':'Approved free access',paymentId:payment,membershipName:r.plan_snapshot.name,validDate:date}});
 }
 /** Why a paid online checkout can no longer become a pass, or null when it can. */
 async unissuable(db:Database,r:PassCheckoutRow){
  const date=new Date(r.valid_date).toISOString().slice(0,10);
  // Staff may have issued a pass at the desk while the member's checkout was still open.
  if(await new StaffModel(db,this.zone).passExists(r.userid,date))return 'You already had a day pass for this date, so this payment did not buy a second one.';
  if(date<businessToday(this.zone))return 'Your payment arrived after this date had ended, so no pass was issued for it.';
  return null;
 }
 /**
  * Record a captured charge and its refund intent before attempting the refund.
  * The cancellation request also lets the member retry a failed refund.
  */
 async recordUnissuedPayment(db:Database,r:PassCheckoutRow,reference:string,reason:string){
  const model=new StaffModel(db,this.zone),amount=(r.amount_cents/100).toFixed(2);
  const payment=await model.createPayment(r.userid,null,amount,'paid','card',reference,'Online day pass (not issued)',r.userid);
  await db.query("UPDATE app_pass_checkout SET payment_id=$2,status='paid',cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1",[r.id,payment]);
  await model.audit(r.userid,r.userid,'daypass.not_issued','payment',payment,reason,null,{checkoutId:r.id,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:'daypass-not-issued:'+r.id,payload:{paymentId:payment,amount,currency:'USD',
   method:'Card (test mode)',reference,planName:r.plan_snapshot.name,validDate:new Date(r.valid_date).toISOString().slice(0,10),instructions:reason+' We are refunding it to your original card.'}});
 }
 async refundUnissued(id:string){
  await providerTransaction(this.pool,async db=>{
   const r=(await db.query<PassCheckoutRow>(`SELECT * FROM app_pass_checkout WHERE id=$1 AND status='paid'
    AND pass_id IS NULL AND payment_id IS NOT NULL AND cancel_requested_at IS NOT NULL AND refund_id IS NULL FOR UPDATE`,[id])).rows[0];
   // A member, staff or a refund webhook may have already recorded an attempt.
   if(r)await this.cardRefund(db,r);
  });
 }
 async freeMembership(userid:number,body:FreeMembershipRequest){
  return transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   await requireActor(db,userid);
   await new AccessService(db,this.zone).assertWaivers(userid);
   // The facility zone: a free membership's end date is a month later on the facility's clock.
   const model=new StaffModel(db,this.zone),plan=await model.plan(positiveId(body.planId),true);
   if(!plan?.active||plan.kind!=='membership'||plan.months!==1)throw new AppError(400,'INVALID_PLAN','Choose an active monthly plan.');
   await expireAbandonedMembershipCheckouts(db,userid);
   const start=new Date().toISOString(),window=await model.membershipWindow(userid,start,1);
   const offer=await quote(db,userid,plan,new Date(window.endsAt).toISOString().slice(0,10));
   if(offer.amountCents!==0)throw new AppError(403,'FREE_ACCESS_INELIGIBLE','Staff-verified free access is required.');
   if(body.expectedRevision!==plan.revision||body.pricingRevision!==offer.pricingRevision)throw new AppError(409,'PRICE_CHANGED','Refresh the current offer.');
   if(window.overlap||(await db.query("SELECT id FROM app_membership_billing WHERE userid=$1 AND status NOT IN ('canceled','expired','incomplete_expired')",[userid])).rowCount)throw new AppError(409,'MEMBERSHIP_EXISTS','A membership or checkout already exists.');
   const snapshot={...plan,price:'0.00'},membership=await model.createMembership(userid,snapshot,start,window.endsAt,userid,'Approved free access: '+offer.basis);
   const payment=await model.createPayment(userid,membership,'0.00','waived','none','free-membership:'+membership,'Approved free access',userid);
   await model.audit(userid,userid,'membership.free.issued','membership',membership,'Approved free access',null,{basis:offer.basis,payment});
   await enqueueNotification(db,{userId:userid,kind:'payment_receipt',dedupeKey:'free-membership:'+membership,payload:{amount:'0.00',currency:'USD',method:'Approved free access',reference:'free-membership:'+membership,membershipName:plan.name}});
   return {issued:true};
  });
 }
 async cancel(userid:number,id:string){
  if(id.startsWith('manual:'))return this.cancelManual(userid,positiveId(Number(id.slice(7))));
  // Persist the timely request before provider calls so retries after the cutoff
  // can finish the same cancellation, not start an unauthorized late one.
  const row=await transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   const r=(await db.query<PassCheckoutRow&{timely:boolean}>('SELECT *,now()<=((valid_date-3)::timestamp AT TIME ZONE $3) AS timely FROM app_pass_checkout WHERE id::text=$1 AND userid=$2 FOR UPDATE',[id,userid,this.zone])).rows[0];
   if(!r)throw new AppError(404,'NOT_FOUND','Day-pass checkout not found.');
   if(r.status==='cancelled'||r.status==='expired')return r;
   if(r.status==='paid'&&!r.cancel_requested_at&&!r.timely)throw new AppError(409,'CANCELLATION_NOTICE','Day passes require at least 3 days cancellation notice.');
   await db.query("UPDATE app_pass_checkout SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1 AND status='paid'",[id]);return r;
  });
  if(['cancelled','expired'].includes(row.status))return {cancelled:true,...unissued(row)};
  if(row.status==='pending'){
   const sdk=this.provider().sdk;
   if(!row.checkout_id){
    if((await this.pool.query(`UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND ${ABANDONED}`,[id])).rowCount)return {cancelled:true};
    throw new AppError(409,'RECONCILE_REQUIRED','Resume checkout before cancelling.');
   }
   let s=await sdk.checkout.sessions.retrieve(row.checkout_id);
   if(s.status==='open')s=await sdk.checkout.sessions.expire(s.id);
   if(s.status!=='expired')throw new AppError(409,'PAYMENT_PROCESSING','Payment completed. Refresh after verification before cancelling.');
   await this.pool.query("UPDATE app_pass_checkout SET status='expired',cancel_requested_at=NULL WHERE id=$1 AND status='pending'",[id]);return {cancelled:true};
  }
  return providerTransaction(this.pool,async db=>{
   const r=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0]!;
   if(r.status==='cancelled')return {cancelled:true,...unissued(r)};
   if(r.amount_cents===0){await this.finishCancel(db,r);return {cancelled:true};}
   const f=await this.cardRefund(db,r);return {cancelled:f.status==='succeeded',refundStatus:f.status,...unissued(r)};
  });
 }
 /** Refunds a paid online checkout to its original card and records the result. */
 async cardRefund(db:Database,r:PassCheckoutRow){
  if(!r.payment_intent)throw new AppError(409,'RECONCILE_REQUIRED','Original card payment must be reconciled.');
  const sdk=this.provider().sdk,existing=await sdk.refunds.list({payment_intent:r.payment_intent,limit:100});
  // Retrying after a failure submits a new refund (see refundAttempt).
  const attempt=refundAttempt('daypass-refund:'+r.id,existing);
  const f=liveRefund(existing,r.amount_cents)??await sdk.refunds.create({payment_intent:r.payment_intent,amount:r.amount_cents,...(attempt.metadata?{metadata:attempt.metadata}:{})},
   {idempotencyKey:attempt.key});
  await this.applyRefund(db,f);return f;
 }
 /**
  * Staff refund of an online card day pass to the original card, at any time: the member's own
  * cancellation needs 3 days' notice. It shares the member's refund key (see cardRefund), so the two
  * can't refund twice, and the pass is cancelled once the refund succeeds.
  */
 async staffRefund(actor:number,id:string,reason:unknown){
  const explanation=textField(reason,'Refund reason',255,3);
  this.provider();
  return providerTransaction(this.pool,async db=>{
   const operator=await requireActor(db,actor,{staff:true});
   const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE id::text=$1',[id])).rows[0];
   if(!owner)throw new AppError(404,'NOT_FOUND','Day-pass payment not found.');
   // This skips the 3-day rule, even for a pass already used, so the staff-account rule applies, as for
   // membership invoices: nobody refunds their own pass, and only administrators refund staff accounts.
   if(owner.userid===actor)throw new AppError(403,'SELF_CHANGE_FORBIDDEN','Another administrator must refund a payment on your own account.');
   await assertManageable(db,operator,owner.userid);
   // Same order as member checkout and cancellation: the member's lock, then the checkout.
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const r=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0]!;
   if(r.refund_status==='succeeded')return {status:'succeeded'};
   const retryCancelled=r.status==='cancelled'&&r.refund_id&&failedRefund({status:r.refund_status});
   if((r.status!=='paid'&&!retryCancelled)||r.amount_cents===0||!r.payment_intent||!r.payment_id)throw new AppError(409,'NOT_PAID','Only a day pass paid by card can be refunded.');
   const f=await this.cardRefund(db,r);
   await new StaffModel(db).audit(actor,r.userid,'billing.refund.requested','payment',r.payment_id,explanation,null,{refundId:f.id,status:f.status});
   return {status:f.status};
  });
 }
 async finishCancel(db:Database,r:Pick<PassCheckoutRow,'id'|'pass_id'|'cancel_requested_at'>){
  await db.query("UPDATE app_pass_checkout SET status='cancelled' WHERE id=$1",[r.id]);
  // Without the member's own request, the refund came from staff or Stripe.
  await db.query("UPDATE day_pass SET status='cancelled',statusdesc=$2,revision=revision+1 WHERE dayid=$1",
   [r.pass_id,r.cancel_requested_at?'Member cancellation with 3 days notice':'Refunded to the original card']);
 }
 async applyRefund(db:Database,f:Stripe.Refund){
  const r=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE',[objectId(f.payment_intent)])).rows[0];
  if(!r)return;
  const failed=failedRefund(f);
  if(refundTransition({refundId:r.refund_id,refundStatus:r.refund_status},f)==='skip')return;
  if(replacedAttemptFailed({refundId:r.refund_id,refundStatus:r.refund_status},f))return;
  if(f.amount!==r.amount_cents||f.currency!=='usd')throw new AppError(409,'RECONCILE_REQUIRED','Refund amount mismatch.');
  await db.query('UPDATE app_pass_checkout SET refund_id=$2,refund_status=$3 WHERE id=$1',[r.id,f.id,f.status]);
  if(f.status==='succeeded'){
   await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1",[r.payment_id]);
   await this.finishCancel(db,r);
   // A refunded checkout was paid and issued, so it has its payment record.
   await new StaffModel(db).audit(r.userid,r.userid,'daypass.refunded','payment',r.payment_id!,'Original-card refund confirmed',null,{refundId:f.id,amount:f.amount});
   await enqueueNotification(db,{userId:r.userid,kind:'payment_refunded',dedupeKey:'daypass-refund:'+r.id+':'+f.id,payload:{reference:f.id,amount:(f.amount/100).toFixed(2),currency:'USD',method:'Original card (test mode)'}});
  }
  if(failed){
   await db.query("UPDATE payment SET paymentstatus='paid',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus='refunded'",[r.payment_id]);
   await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=ANY($1::text[]) AND status='pending'",[[`daypass-refund:${r.id}`,`daypass-refund:${r.id}:${f.id}`]]);
   // The pass is only cancelled once a refund succeeds, so say whether it is still usable.
   await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:`daypass-refund-failed:${r.id}:${f.id}`,payload:{paymentId:r.payment_id,reference:f.id,instructions:!r.pass_id
    ?'The original-card refund for your day-pass payment did not go through. No pass was issued for it; contact staff to complete the refund.'
    :r.status==='cancelled'
    ?'The original-card refund for your cancelled day pass failed after it was confirmed. Your pass stays cancelled; contact staff to complete the refund.'
    // Only the member's own cancellation can be retried from Membership & passes after the cancel-by date: a refund
    // staff started (here or in Stripe) may fall inside the 3-day window, where the member's cancel is refused.
    :r.cancel_requested_at
    ?'The original-card refund for your day pass did not go through, so the pass has not been cancelled and is still valid. Retry the refund from Membership & passes, or contact staff.'
    :'The original-card refund for your day pass did not go through, so the pass has not been cancelled and is still valid. Contact staff to complete the refund.'}});
  }
 }
 async refundEvent(db:Database,obj:Stripe.Refund){
  const pi=objectId(obj.payment_intent);
  if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund payment intent missing.');
  const row=(await db.query<{id:string}>('SELECT id FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE',[pi])).rows[0];
  if(!row)return;
  const f=await this.provider().sdk.refunds.retrieve(obj.id);
  if(f.id!==obj.id||objectId(f.payment_intent)!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund identity mismatch.');
  await this.applyRefund(db,f);
 }
 async webhook(event:Stripe.Event){
  if(event.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test events only.');
  const sdk=this.provider().sdk;
  const refundCheckout=await providerTransaction(this.pool,async db=>{
   if(!(await db.query('INSERT INTO app_pass_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[event.id])).rowCount){
    // The charge and event can be committed even when the automatic refund call failed.
    if(!isCheckoutSessionEvent(event))return;
    return (await db.query<{id:string}>(`SELECT id FROM app_pass_checkout WHERE checkout_id=$1 AND status='paid'
     AND pass_id IS NULL AND payment_id IS NOT NULL AND cancel_requested_at IS NOT NULL AND refund_id IS NULL`,[event.data.object.id])).rows[0]?.id;
   }
   if(isRefundEvent(event)){await this.refundEvent(db,event.data.object);return;}
   if(!isCheckoutSessionEvent(event))return;
   const obj=event.data.object;
   // Ignore other products' Checkout events without an unnecessary provider call.
   const known=(await db.query<{id:string}>('SELECT id FROM app_pass_checkout WHERE checkout_id=$1 OR id::text=$2',[obj.id,obj.metadata?.dayPassCheckoutId??''])).rows[0];
   if(!known)return;
   const s=await sdk.checkout.sessions.retrieve(obj.id),id=s.metadata?.dayPassCheckoutId;
   if(!id)return;
   const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE id::text=$1',[id])).rows[0];if(!owner)return;
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const r=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0]!;
   if(s.livemode||s.mode!=='payment'||s.client_reference_id!==r.id||r.checkout_id&&s.id!==r.checkout_id||s.amount_total!==r.amount_cents||s.currency!=='usd')throw new AppError(400,'PAYMENT_MISMATCH','Day-pass payment does not match checkout.');
   if(s.status==='expired'){await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending'",[id]);return;}
   if(event.type==='checkout.session.async_payment_failed'&&s.payment_status==='unpaid'){
    const failed=await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' RETURNING id",[id]);
    if(failed.rowCount)await enqueueNotification(db,{userId:r.userid,kind:'payment_failed',dedupeKey:'pass-failed:'+id,
     payload:{reference:s.id,planName:r.plan_snapshot.name,instructions:'Your payment did not go through, so this day pass was not issued. Try again from Membership & passes.'}});
    return;
   }
   if(s.status!=='complete'||s.payment_status!=='paid')return;
   const pi=objectId(s.payment_intent);if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment missing.');
   await db.query('UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3 WHERE id=$1',[id,s.id,pi]);
   const unissuable=r.pass_id||r.payment_id?null:await this.unissuable(db,r);
   if(unissuable){await this.recordUnissuedPayment(db,r,s.id,unissuable);return id;}
   if(r.payment_id&&!r.pass_id&&!r.refund_id)return id;
   await this.issue(db,r,s.id);
   // Refund delivery can precede checkout delivery. Reconcile the original
   // payment so a late checkout cannot grant access to an already-refunded pass.
   const refunds=await sdk.refunds.list({payment_intent:pi,limit:100});
   const refund=liveRefund(refunds,r.amount_cents)??refunds.data[0];
   if(refund)await this.applyRefund(db,refund);
  });
  if(refundCheckout)await this.refundUnissued(refundCheckout);
 }
}
