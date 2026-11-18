// Coordinates day-pass checkout, issuance and cancellation, including separate handling for
// payments recorded at the desk.

import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import Stripe from 'stripe';
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
import {errorIdentifier} from '../logSafety.js';
import {quote} from './pricing.js';
import {failedRefund,refundAttempt,refundTransition,replacedAttemptFailed} from './refundTransition.js';
import {isCheckoutSessionEvent,isRefundEvent} from './stripeEvents.js';
import {expireAbandonedMembershipCheckouts} from './openBilling.js';
import {providerTransaction} from './providerGate.js';
/** An app_pass_checkout row. */
interface PassCheckoutRow {id:string;userid:number;tierid:number;valid_date:Date;plan_snapshot:Plan;amount_cents:number;
 status:'pending'|'paid'|'cancelled'|'expired';checkout_id:string|null;payment_intent:string|null;pass_id:number|null;payment_id:number|null;
 cancel_requested_at:Date|null;refund_id:string|null;refund_status:string|null;refund_needs_review:boolean;refund_reconcile_after:Date|null;checkout_has_expiry:boolean;checkout_email:string|null;checkout_expires_at:Date|null;created_at:Date;}
/** Day-pass checkout request; each field is validated by PassBilling.checkout. */
export interface PassCheckoutRequest {[field:string]:unknown;validDate?:unknown;planId?:unknown;expectedRevision?:unknown;pricingRevision?:unknown;amountCents?:unknown;}
/** Free monthly membership request; each field is validated by PassBilling.freeMembership. */
export interface FreeMembershipRequest {[field:string]:unknown;planId?:unknown;expectedRevision?:unknown;pricingRevision?:unknown;}
const objectId=(v:string|{id:string}|null|undefined):string|undefined=>typeof v==='string'?v:v?.id;
/** Marks a payment that never became a pass (see recordUnissuedPayment), so the member isn't told about a pass. */
const unissued=(r:Pick<PassCheckoutRow,'pass_id'|'payment_id'>)=>r.payment_id&&!r.pass_id?{passIssued:false as const}:{};
const canRetryUnissuedRefund=(r:PassCheckoutRow)=>!r.pass_id&&!!r.payment_id&&!!r.cancel_requested_at&&r.refund_status!=='succeeded';
const STRIPE_MIN_WINDOW=30*60*1000;
const CHECKOUT_RETRY_WINDOW=23*60*60*1000;
const CHECKOUT_ABANDONMENT_WINDOW=24*60*60*1000;
const tooLateToCreate=(expiry:Date)=>Math.floor(expiry.getTime()/1000)*1000-Date.now()<STRIPE_MIN_WINDOW;
const reviewRequired=(staffReview=false)=>new AppError(409,'RECONCILE_REQUIRED',staffReview
 ?'Check the original charge in Stripe. Wait for any pending refunds to finish. If a partial refund has settled, choose Honor the visit for an eligible pass or refund the rest in Stripe and complete the review here.'
 :'This day-pass refund needs staff review.');
const closedForToday=()=>new AppError(409,'CHECKOUT_TOO_LATE','Card checkout closes 30 minutes before the visit date ends. Choose a later date or contact staff.');
export class PassBilling {
 constructor(readonly pool:Pool,readonly stripe?:StudioStripe,readonly zone='America/New_York'){}
 provider(){if(!this.stripe)throw new AppError(503,'PAYMENTS_UNAVAILABLE','Card checkout is not configured.');return this.stripe;}
 async mine(userid:number){
  // Staff can put an issued pass on hold or revoke it; show that, not the checkout's 'paid'.
  // cancelRequested: the member's own cancellation (or an unissued payment's refund) is recorded, so cancel()
  // retries a failed refund after the notice deadline; a staff refund isn't, so only staff retry it then.
  // passIssued is false for a card payment that never became a pass (see recordUnissuedPayment): only its refund remains.
  const online=(await this.pool.query(`SELECT c.id,c.plan_snapshot AS plan,to_char(c.valid_date,'YYYY-MM-DD') AS "validDate",c.amount_cents AS "amountCents",
  CASE WHEN c.status='paid' AND d.status IN ('suspended','revoked') THEN d.status
    WHEN c.status='cancelled' AND c.payment_id IS NOT NULL AND c.pass_id IS NULL AND c.cancel_requested_at IS NOT NULL
      AND c.refund_status IS DISTINCT FROM 'succeeded' THEN 'paid'
    ELSE c.status END AS status,CASE WHEN c.refund_needs_review THEN 'needs_review' ELSE c.refund_status END AS "refundStatus",
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
 async checkout(userid:number,body:PassCheckoutRequest):Promise<{issued:true;checkoutUrl?:never}|{checkoutUrl:string;issued?:never}>{
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
   const old=(await db.query<PassCheckoutRow>("SELECT * FROM app_pass_checkout WHERE userid=$1 AND valid_date=$2 AND status NOT IN ('expired','cancelled') FOR UPDATE",[userid,date])).rows[0];
   if(old){if(old.tierid!==id||old.amount_cents!==offer.amountCents)throw new AppError(409,'CHECKOUT_EXISTS','Cancel the existing checkout before changing plans.');return {...old,email:user.email};}
   if(await model.passExists(userid,date))throw new AppError(409,'PASS_EXISTS','You already have a pass for this date.');
   const started=new Date();
   let payBy:Date|null=null;
   if(offer.amountCents>0){
    this.provider();
    payBy=await model.newPassCheckoutPayBy(date,started);
    if(tooLateToCreate(payBy))throw closedForToday();
   }
   const r=(await db.query<PassCheckoutRow>(`INSERT INTO app_pass_checkout
    (id,userid,tierid,valid_date,plan_snapshot,amount_cents,checkout_has_expiry,checkout_email,checkout_expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9) RETURNING *`,[randomUUID(),userid,id,date,JSON.stringify({...plan,price:(offer.amountCents/100).toFixed(2),priceBasis:offer.basis}),offer.amountCents,payBy?user.email:null,payBy,started])).rows[0]!;
   if(r.amount_cents===0)await this.issue(db,r,'free:'+r.id);
   return {...r,email:user.email};
  });
  if(row.amount_cents===0)return {issued:true};
  if(row.status!=='pending')throw new AppError(409,'PASS_EXISTS','This pass is already issued or cancelled. Refresh its status.');
  if(row.payment_id)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
  const p=this.provider();
  let s:Stripe.Checkout.Session|undefined;
  if(row.checkout_id){
   s=await p.sdk.checkout.sessions.retrieve(row.checkout_id);
  }else{
   const age=Date.now()-row.created_at.getTime();
   // A legacy create used the row's old request shape. In particular, a same-day request without
   // a pinned deadline could take payment after midnight; only recover an existing session then.
   const legacyToday=!row.checkout_expires_at&&date===businessToday(this.zone);
   if(age>=CHECKOUT_RETRY_WINDOW||legacyToday||(row.checkout_expires_at&&tooLateToCreate(row.checkout_expires_at))){
    s=await this.findCheckoutSession(row);
    if(!s){
     if((legacyToday||age>=CHECKOUT_ABANDONMENT_WINDOW)&&(await this.expireUnpaidCheckout(row.id,true)).rowCount)
      return this.checkout(userid,body);
     if(date===businessToday(this.zone)&&tooLateToCreate(await new StaffModel(this.pool,this.zone).newPassCheckoutPayBy(date,new Date())))
      throw closedForToday();
     throw new AppError(409,'RECONCILE_REQUIRED','This checkout can no longer be resumed. Try again after it expires.');
    }
   }else{
    // Pre-cutover rows retain their original URL and expiry parameters under the existing key.
    const payBy=row.checkout_expires_at??(row.checkout_has_expiry?new Date(row.created_at.getTime()+CHECKOUT_RETRY_WINDOW):null);
    try{
     s=await p.sdk.checkout.sessions.create({mode:'payment',payment_method_types:['card'],client_reference_id:row.id,customer_email:row.checkout_email??row.email,
      metadata:{dayPassCheckoutId:row.id},success_url:p.config.origin+returnPath+'&pass=returned'+(row.checkout_has_expiry?'&checkout='+row.id:''),cancel_url:p.config.origin+returnPath+'&pass=cancelled',
      ...(payBy?{expires_at:Math.floor(payBy.getTime()/1000)}:{}),
      payment_intent_data:{metadata:{dayPassCheckoutId:row.id}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:row.amount_cents,product_data:{name:row.plan_snapshot.name}}}]},{idempotencyKey:'daypass-checkout:'+row.id});
    }catch(error){
     // The pinned same-day expiry has only a short window near closing. It can
     // cross Stripe's 30-minute minimum in transit after passing the local check.
     if(payBy&&date===businessToday(this.zone)&&error instanceof Stripe.errors.StripeInvalidRequestError&&error.param==='expires_at')
      throw closedForToday();
     if(!(error instanceof Stripe.errors.StripeIdempotencyError))throw error;
     // The profile email (or return origin) may have changed since a successful create whose
     // response was lost. Search by the stable checkout identity, never create with a different key.
     s=await this.findCheckoutSession(row);
     if(!s)throw new AppError(409,'RECONCILE_REQUIRED','Your original card checkout could not be verified. Try again after it expires or contact staff.');
    }
   }
  }
  if(s.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test payments only.');
  // A legacy create started on the previous day can finish after its row
  // was cleared. Only send a session URL for a checkout that still owns it.
  const bound=await this.pool.query("UPDATE app_pass_checkout SET checkout_id=$2 WHERE id=$1 AND status='pending' AND (checkout_id IS NULL OR checkout_id=$2)",[row.id,s.id]);
  if(!bound.rowCount)throw new AppError(409,'PAYMENT_PROCESSING','Checkout changed. Refresh its status.');
  if(s.status==='expired'){await this.expireUnpaidCheckout(row.id);throw new AppError(409,'CHECKOUT_EXPIRED','Checkout expired. Refresh and try again.');}
  if(s.status!=='open'||!s.url)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
  return {checkoutUrl:s.url};
 }
 private async findCheckoutSession(row:PassCheckoutRow){
  const sdk=this.provider().sdk;
  const params:Stripe.Checkout.SessionListParams={limit:100,created:{gte:Math.floor(row.created_at.getTime()/1000)-60}};
  for(;;){
   const page=await sdk.checkout.sessions.list(params);
   const s=page.data.find(session=>session.client_reference_id===row.id&&session.metadata?.dayPassCheckoutId===row.id);
   if(s){
    if(s.livemode||s.mode!=='payment'||s.amount_total!==row.amount_cents||s.currency!=='usd')
     throw new AppError(400,'PAYMENT_MISMATCH','Day-pass payment does not match checkout.');
    return s;
   }
   if(!page.has_more)return;
   params.starting_after=page.data.at(-1)!.id;
  }
 }
 private async expireUnpaidCheckout(id:string,unbound=false){
  return this.pool.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND payment_id IS NULL AND (NOT $2 OR checkout_id IS NULL)",[id,unbound]);
 }
 async issue(db:Database,r:PassCheckoutRow,reference:string){
  if(r.pass_id)return;
  const model=new StaffModel(db,this.zone),date=new Date(r.valid_date).toISOString().slice(0,10);
  if(await model.passExists(r.userid,date))throw new AppError(409,'PASS_EXISTS','An existing pass requires payment reconciliation.');
  const pass=await model.createPass(r.userid,r.plan_snapshot,date,r.userid,'Online day pass');
  const payment=r.payment_id??await model.createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),r.amount_cents?'paid':'waived',r.amount_cents?'card':'none',reference,'Online day pass',r.userid);
  await model.linkPassPayment(pass,payment);
  await db.query("UPDATE app_pass_checkout SET pass_id=$2,payment_id=$3,status='paid' WHERE id=$1",[r.id,pass,payment]);
  await model.audit(r.userid,r.userid,'daypass.issued','day_pass',pass,'Online day pass',null,{payment,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_receipt',dedupeKey:'daypass-receipt:'+r.id,payload:{amount:(r.amount_cents/100).toFixed(2),currency:'USD',reference,method:r.amount_cents?'Card (test mode)':'Approved free access',paymentId:payment,membershipName:r.plan_snapshot.name,validDate:date}});
 }
 private visitEnded(r:PassCheckoutRow){
  return new Date(r.valid_date).toISOString().slice(0,10)<businessToday(this.zone);
 }
 private async hasDeskPass(db:Database,r:PassCheckoutRow){
  return new StaffModel(db,this.zone).passExists(r.userid,new Date(r.valid_date).toISOString().slice(0,10));
 }
 /**
  * Record a captured charge and its refund intent before attempting the refund.
  * The cancellation request also lets the member retry a failed refund.
  */
 async recordUnissuedPayment(db:Database,r:PassCheckoutRow,reference:string,duplicateCheckout=false){
  const reason=duplicateCheckout?'Another checkout already covers this visit, so no pass was issued for this payment.'
   :'You already had a day pass for this date, so this payment did not buy a second one.';
  const model=new StaffModel(db,this.zone),amount=(r.amount_cents/100).toFixed(2);
  const payment=r.payment_id??await model.createPayment(r.userid,null,amount,'paid','card',reference,'Online day pass (not issued)',r.userid);
  await db.query("UPDATE app_pass_checkout SET payment_id=$2,status=$3,cancel_requested_at=COALESCE(cancel_requested_at,now()),refund_reconcile_after=now() WHERE id=$1",
   [r.id,payment,duplicateCheckout?'cancelled':'paid']);
  await model.audit(r.userid,r.userid,'daypass.not_issued','payment',payment,reason,null,{checkoutId:r.id,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:'daypass-not-issued:'+r.id,payload:{paymentId:payment,amount,currency:'USD',
   method:'Card (test mode)',reference,planName:r.plan_snapshot.name,validDate:new Date(r.valid_date).toISOString().slice(0,10),instructions:reason+' We are refunding it to your original card.'}});
 }
 /** Retry unfinished refund work when the checkout webhook stops being redelivered. */
 async reconcileRefunds(){
  if(!this.stripe)return;
  // Claim a bounded batch across replicas. A failed or interrupted attempt becomes due again in a minute.
  const rows=(await this.pool.query<{id:string}>(`WITH due AS (
    SELECT id FROM app_pass_checkout WHERE refund_reconcile_after<=now()
    ORDER BY refund_reconcile_after LIMIT 20 FOR UPDATE SKIP LOCKED
   ) UPDATE app_pass_checkout c SET refund_reconcile_after=now()+interval '1 minute'
   FROM due WHERE c.id=due.id RETURNING c.id`)).rows;
  await Promise.all(rows.map(({id})=>this.reconcileRefund(id).catch(error=>
   console.error('Day-pass refund reconciliation deferred',{checkoutId:id,...errorIdentifier(error)}))));
 }
 private async reconcileRefund(id:string){
  await providerTransaction(this.pool,async db=>{
   const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE id=$1',[id])).rows[0];
   if(!owner)return;
   // Issuance must serialize with desk sales and member cancellation.
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const r=(await db.query<PassCheckoutRow>(`SELECT * FROM app_pass_checkout
    WHERE id=$1 AND refund_reconcile_after IS NOT NULL FOR UPDATE`,[id])).rows[0];
   if(!r)return;
   const sdk=this.provider().sdk;
   const refunds=await sdk.refunds.list({payment_intent:r.payment_intent!,limit:100});
   let outcome=await this.observeRefunds(db,r,refunds);
   const refundingDuplicate=r.status==='cancelled'&&canRetryUnissuedRefund(r);
   if(!outcome&&refundingDuplicate&&!r.refund_needs_review&&!r.refund_id)
    outcome=await this.submitRefund(db,r,refunds);
   if(outcome&&outcome!=='review'&&outcome!=='split'&&['pending','requires_action'].includes(outcome.status??'')&&
      (r.status==='pending'||refundingDuplicate)){
    // Keep checking an in-flight full refund even if Stripe stops delivering events.
    await db.query("UPDATE app_pass_checkout SET refund_reconcile_after=now()+interval '1 minute' WHERE id=$1",[id]);
    return;
   }
   if(!outcome&&!r.refund_needs_review&&!r.pass_id&&r.payment_id&&r.status!=='cancelled'){
    if(this.visitEnded(r)){
     // Rollback can leave manual admissions in the shift log only.
     await this.flagRefundReview(db,r);
    }else if(r.status==='pending'){
     if(await this.hasDeskPass(db,r)){
      await this.recordUnissuedPayment(db,r,r.checkout_id!);
      await this.submitRefund(db,r,refunds);
     }else{
      await this.issue(db,r,r.checkout_id!);
     }
    }else if(r.cancel_requested_at&&!r.refund_id){
     await this.submitRefund(db,r,refunds);
    }
   }
   await db.query('UPDATE app_pass_checkout SET refund_reconcile_after=NULL WHERE id=$1',[id]);
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
   if(r.status==='expired'||r.status==='cancelled'&&!canRetryUnissuedRefund(r))return r;
   if(r.refund_needs_review)throw reviewRequired();
   if(r.status==='paid'&&!r.cancel_requested_at&&!r.timely)throw new AppError(409,'CANCELLATION_NOTICE','Day passes require at least 3 days cancellation notice.');
   await db.query("UPDATE app_pass_checkout SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1 AND status='paid'",[id]);return r;
  });
  if(row.status==='expired'||row.status==='cancelled'&&!canRetryUnissuedRefund(row))return {cancelled:true,...unissued(row)};
  if(row.status==='pending'){
   if(row.payment_id)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh after verification before cancelling.');
   const sdk=this.provider().sdk;
   let s:Stripe.Checkout.Session|undefined;
   if(row.checkout_id){
    s=await sdk.checkout.sessions.retrieve(row.checkout_id);
   }else{
    const legacyToday=!row.checkout_expires_at&&new Date(row.valid_date).toISOString().slice(0,10)===businessToday(this.zone);
    if(!legacyToday&&Date.now()-row.created_at.getTime()<CHECKOUT_ABANDONMENT_WINDOW)throw new AppError(409,'RECONCILE_REQUIRED','Resume checkout before cancelling.');
    s=await this.findCheckoutSession(row);
    if(!s&&(await this.expireUnpaidCheckout(id,true)).rowCount)return {cancelled:true};
    if(!s)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
   }
   if(s.status==='open')s=await sdk.checkout.sessions.expire(s.id);
   if(s.status!=='expired')throw new AppError(409,'PAYMENT_PROCESSING','Payment completed. Refresh after verification before cancelling.');
   await this.pool.query("UPDATE app_pass_checkout SET status='expired',cancel_requested_at=NULL WHERE id=$1 AND status='pending' AND payment_id IS NULL",[id]);return {cancelled:true};
  }
  const result=await providerTransaction(this.pool,async db=>{
   const r=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0]!;
   if(r.status==='cancelled'&&!canRetryUnissuedRefund(r))return {cancelled:true,...unissued(r)};
   if(r.amount_cents===0){await this.finishCancel(db,r);return {cancelled:true};}
   const f=await this.cardRefund(db,r);return {cancelled:f.status==='succeeded',refundStatus:f.status,...unissued(r)};
  });
  if('refundStatus' in result&&result.refundStatus==='needs_review')throw reviewRequired();
  return result;
 }
 private async cardRefund(db:Database,r:PassCheckoutRow){
  if(r.refund_needs_review)return {id:null,status:'needs_review'};
  if(!r.payment_intent)throw new AppError(409,'RECONCILE_REQUIRED','Original card payment must be reconciled.');
  const list=await this.provider().sdk.refunds.list({payment_intent:r.payment_intent,limit:100});
  const outcome=await this.observeRefunds(db,r,list);
  if(outcome==='review'||(outcome&&outcome!=='split'&&'refundIds' in outcome))return {id:null,status:'needs_review'};
  if(outcome==='split')return {id:null,status:'succeeded'};
  return outcome??await this.submitRefund(db,r,list);
 }
 /** Only called after Stripe shows that none of the charge has been refunded. */
 private async submitRefund(db:Database,r:PassCheckoutRow,list:Stripe.ApiList<Stripe.Refund>){
  const attempt=refundAttempt('daypass-refund:'+r.id,list);
  const f=await this.provider().sdk.refunds.create({payment_intent:r.payment_intent!,amount:r.amount_cents,...(attempt.metadata?{metadata:attempt.metadata}:{})},
   {idempotencyKey:attempt.key});
  await this.applyRefund(db,f);return f;
 }
 /**
  * Staff refund of an online card day pass to the original card, at any time: the member's own
  * cancellation needs 3 days' notice. It shares the member's refund key (see cardRefund), so the two
  * can't refund twice, and the pass is cancelled once the refund succeeds.
  */
 async staffRefund(actor:number,id:string,reason:unknown,review=false,honorVisit=false){
  const explanation=textField(reason,'Refund reason',255,3);
  this.provider();
  const result=await providerTransaction(this.pool,async db=>{
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
   if(r.amount_cents===0||!r.payment_intent||!r.payment_id||r.status==='expired')
    throw new AppError(409,'NOT_PAID','Only a day pass paid by card can be refunded.');
   const model=new StaffModel(db,this.zone);
   if(review){
    if(!r.refund_needs_review)return {status:'reviewed'};
    const sdk=this.provider().sdk;
    // Read the charge first, then the latest refund list before making any access decision.
    const intent=honorVisit?await sdk.paymentIntents.retrieve(r.payment_intent,{expand:['latest_charge']}):undefined;
    const charge=intent?.latest_charge;
    const verifiedCharge=intent?.id===r.payment_intent&&!intent.livemode&&intent.status==='succeeded'&&charge&&typeof charge!=='string'&&
     !charge.livemode&&objectId(charge.payment_intent)===r.payment_intent&&charge.paid&&charge.status==='succeeded'&&charge.captured&&
     charge.currency==='usd'&&charge.amount_captured===r.amount_cents?charge.id:undefined;
    const list=await sdk.refunds.list({payment_intent:r.payment_intent,limit:100});
    const outcome=await this.observeRefunds(db,r,list,verifiedCharge);
    if(outcome==='review'||(outcome&&outcome!=='split'&&outcome.status!=='succeeded'&&!('refundIds' in outcome)))
     return {status:'needs_review'};
    const partial=outcome&&outcome!=='split'&&'refundIds' in outcome?outcome:undefined;
    if(partial){
     if(r.status==='pending'&&!r.pass_id&&!this.visitEnded(r)&&!await this.hasDeskPass(db,r))await this.issue(db,r,r.checkout_id!);
     else if(r.status!=='paid'||!r.pass_id)return {status:'needs_review'};
     await db.query("UPDATE app_pass_checkout SET refund_id=NULL,refund_status='partial' WHERE id=$1",[id]);
    }
    if(!outcome&&!r.pass_id&&r.status!=='cancelled'){
     if(honorVisit&&!verifiedCharge)return {status:'needs_review'};
     if(r.status==='pending'&&!await this.hasDeskPass(db,r)&&!this.visitEnded(r))await this.issue(db,r,r.checkout_id!);
     else await db.query("UPDATE app_pass_checkout SET status='paid',cancel_requested_at=NULL WHERE id=$1",[id]);
    }
    await db.query('UPDATE app_pass_checkout SET refund_needs_review=false,refund_reconcile_after=NULL WHERE id=$1',[id]);
    const settlement=partial?{refundIds:partial.refundIds,refundedCents:partial.amount,retainedCents:r.amount_cents-partial.amount}:{};
    await model.audit(actor,r.userid,'billing.refund.reviewed','payment',r.payment_id,explanation,null,{checkoutId:id,...settlement});
    return {status:'reviewed'};
   }
   const f=await this.cardRefund(db,r);
   if(f.status!=='needs_review')await model.audit(actor,r.userid,'billing.refund.requested','payment',r.payment_id,explanation,null,{refundId:f.id,status:f.status});
   return {status:f.status};
  });
  if(result.status==='needs_review')throw reviewRequired(review);
  return result;
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
  if(f.status==='succeeded'){
   if(r.refund_status==='succeeded'&&r.refund_id===f.id)return;
  }else if(refundTransition({refundId:r.refund_id,refundStatus:r.refund_status},f)==='skip')return;
  if(replacedAttemptFailed({refundId:r.refund_id,refundStatus:r.refund_status},f))return;
  if(f.amount!==r.amount_cents||f.currency!=='usd')throw new AppError(409,'RECONCILE_REQUIRED','Refund amount mismatch.');
  await db.query('UPDATE app_pass_checkout SET refund_id=$2,refund_status=$3 WHERE id=$1',[r.id,f.id,f.status]);
  if(f.status==='succeeded')await this.recordConfirmedRefund(db,r,f.id,[f.id],f.id);
  if(failed){
   await db.query("UPDATE payment SET paymentstatus='paid',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus='refunded'",[r.payment_id]);
   await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=ANY($1::text[]) AND status='pending'",[[`daypass-refund:${r.id}`,`daypass-refund:${r.id}:${f.id}`]]);
   const failure=r.refund_id===f.id&&r.refund_status==='succeeded'?'failed after it was confirmed':'did not go through';
   // The pass is only cancelled once a refund succeeds, so say whether it is still usable.
   await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:`daypass-refund-failed:${r.id}:${f.id}`,payload:{paymentId:r.payment_id,reference:f.id,instructions:r.status==='pending'
    ?'The original-card refund for your day-pass payment did not go through. Refresh Membership & passes to see the status of your pass.'
    :!r.pass_id
    ?'The original-card refund for your day-pass payment did not go through. No pass was issued for it; contact staff to complete the refund.'
    :r.status==='cancelled'
    ?`The original-card refund for your cancelled day pass ${failure}. Your pass stays cancelled; contact staff to complete the refund.`
    // Only the member's own cancellation can be retried from Membership & passes after the cancel-by date: a refund
    // staff started (here or in Stripe) may fall inside the 3-day window, where the member's cancel is refused.
    :r.cancel_requested_at
    ?'The original-card refund for your day pass did not go through, so the pass has not been cancelled and is still valid. Retry the refund from Membership & passes, or contact staff.'
    :'The original-card refund for your day pass did not go through, so the pass has not been cancelled and is still valid. Contact staff to complete the refund.'}});
  }
 }
 private async recordConfirmedRefund(db:Database,r:PassCheckoutRow,reference:string,refundIds:string[],dedupeSuffix:string){
  if(r.refund_status==='succeeded'){
   await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=$1 AND status='pending'",
    ['daypass-refund:'+r.id+':'+(r.refund_id??'split')]);
  }else{
   await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1",[r.payment_id]);
   await this.finishCancel(db,r);
  }
  const refund=refundIds.length===1?{refundId:refundIds[0]}:{refundIds};
  await new StaffModel(db).audit(r.userid,r.userid,'daypass.refunded','payment',r.payment_id!,'Original-card refund confirmed',null,{...refund,amount:r.amount_cents});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_refunded',dedupeKey:'daypass-refund:'+r.id+':'+dedupeSuffix,
   payload:{reference,amount:(r.amount_cents/100).toFixed(2),currency:'USD',method:'Original card (test mode)'}});
 }
 private async flagRefundReview(db:Database,r:PassCheckoutRow){
  if(r.refund_needs_review)return;
  await db.query('UPDATE app_pass_checkout SET refund_needs_review=true WHERE id=$1',[r.id]);
  console.error('Day-pass refund requires staff reconciliation',{checkoutId:r.id,code:'RECONCILE_REQUIRED'});
 }
 /** Reconcile against the whole payment. A webhook's individual refund can already be superseded. */
 private async observeRefunds(db:Database,r:PassCheckoutRow,list:Stripe.ApiList<Stripe.Refund>,verifiedCharge?:string):
  Promise<'review'|'split'|Pick<Stripe.Refund,'id'|'status'>|{status:'partial';amount:number;refundIds:string[]}|undefined>{

  const live=list.data.filter(f=>!failedRefund(f));
  const settled=live.filter(f=>f.status==='succeeded');
  const total=settled.reduce((amount,f)=>amount+f.amount,0);
  // Stripe permits one successful charge per PaymentIntent. Refunds that
  // identify different charges are inconsistent with the captured checkout.
  const complete=!list.has_more&&new Set(list.data.map(f=>f.id)).size===list.data.length&&
   new Set(list.data.map(f=>objectId(f.charge)).filter(Boolean)).size<=1&&
   list.data.every(f=>objectId(f.payment_intent)===r.payment_intent&&f.currency==='usd'&&
    Number.isInteger(f.amount)&&f.amount>0&&f.amount<=r.amount_cents)&&
   live.every(f=>f.status==='succeeded'||f.status==='pending'||f.status==='requires_action');
  if(complete&&total===r.amount_cents&&settled.length===live.length){
   if(settled.length===1){
    await this.applyRefund(db,settled[0]!);
    return settled[0]!;
   }
   // Replace a previously recorded full refund ID too, so a delayed failure
   // of that refund cannot undo its successful replacements.
   if(r.refund_status!=='succeeded'||r.refund_id){
    await db.query("UPDATE app_pass_checkout SET refund_id=NULL,refund_status='succeeded' WHERE id=$1",[r.id]);
    await this.recordConfirmedRefund(db,r,r.payment_intent!,settled.map(f=>f.id).sort(),'split');
   }
   return 'split';
  }
  if(verifiedCharge&&complete&&total>0&&total<r.amount_cents&&settled.length===live.length&&
     r.refund_status!=='succeeded'&&live.every(f=>objectId(f.charge)===verifiedCharge)&&
     (!r.refund_id||list.data.some(f=>f.id===r.refund_id)))
   return {status:'partial',amount:total,refundIds:settled.map(f=>f.id).sort()};
  const recordedFailure=list.data.find(f=>f.id===r.refund_id&&failedRefund(f));
  if(complete&&live.length===0&&(r.refund_status!=='succeeded'||recordedFailure)){
   // A missing list entry cannot prove that a known in-flight refund failed.
   if(!recordedFailure&&r.refund_id&&(r.refund_status==='pending'||r.refund_status==='requires_action'))
    return {id:r.refund_id,status:r.refund_status} satisfies Pick<Stripe.Refund,'id'|'status'>;
   const failed=recordedFailure??list.data.find(f=>f.amount===r.amount_cents&&failedRefund(f));
   if(failed)await this.applyRefund(db,failed);
   return;
  }
  if(complete&&live.length===1&&live[0]!.amount===r.amount_cents&&r.refund_status!=='succeeded'){
   await this.applyRefund(db,live[0]!);
   return live[0]!;
  }
  // A confirmed refund can fail after cancelling access. Correct the payment
  // ledger when Stripe shows the failure; keep the cancellation and review flag.
  if(complete&&total<r.amount_cents&&r.refund_status==='succeeded'&&
     (recordedFailure||(!r.refund_id&&list.data.some(failedRefund)))){
   await db.query("UPDATE payment SET paymentstatus='paid',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus='refunded'",[r.payment_id]);
   await db.query("UPDATE app_pass_checkout SET refund_id=NULL,refund_status=NULL WHERE id=$1",[r.id]);
   await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=$1 AND status='pending'",
    ['daypass-refund:'+r.id+':'+(r.refund_id??'split')]);
  }
  await this.flagRefundReview(db,r);
  return 'review';
 }
 async refundEvent(db:Database,obj:Stripe.Refund){
  const pi=objectId(obj.payment_intent);
  if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund payment intent missing.');
  const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE payment_intent=$1',[pi])).rows[0];
  if(!owner)return;
  await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
  const row=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE',[pi])).rows[0]!;
  const sdk=this.provider().sdk,f=await sdk.refunds.retrieve(obj.id);
  if(f.id!==obj.id||objectId(f.payment_intent)!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund identity mismatch.');
  const list=await sdk.refunds.list({payment_intent:pi,limit:100});
  // The list can lag an individual refund. Use the fresh object if it is
  // missing, while retaining the later list's view of any other refunds.
  if(!list.data.some(refund=>refund.id===f.id))list.data.push(f);
  await this.observeRefunds(db,row,list);
 }
 async webhook(event:Stripe.Event){
  if(event.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test events only.');
  const sdk=this.provider().sdk;
  const refundCheckout=await providerTransaction(this.pool,async db=>{
   if(!(await db.query('INSERT INTO app_pass_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[event.id])).rowCount){
    // The charge and event can be committed even when the automatic refund call failed.
    if(!isCheckoutSessionEvent(event))return;
    return (await db.query<{id:string}>(`SELECT id FROM app_pass_checkout
     WHERE checkout_id=$1 AND refund_reconcile_after IS NOT NULL`,[event.data.object.id])).rows[0]?.id;
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
   if(s.status==='expired'){await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND payment_id IS NULL",[id]);return;}
   if(event.type==='checkout.session.async_payment_failed'&&s.payment_status==='unpaid'){
    const failed=await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND payment_id IS NULL RETURNING id",[id]);
    if(failed.rowCount)await enqueueNotification(db,{userId:r.userid,kind:'payment_failed',dedupeKey:'pass-failed:'+id,
     payload:{reference:s.id,planName:r.plan_snapshot.name,instructions:'Your payment did not go through, so this day pass was not issued. Try again from Membership & passes.'}});
    return;
   }
   if(s.status!=='complete'||s.payment_status!=='paid')return;
   const pi=objectId(s.payment_intent);
   if(!pi||r.payment_intent&&r.payment_intent!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment does not match checkout.');
   await db.query('UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3 WHERE id=$1',[id,s.id,pi]);
   if(r.payment_id)return r.refund_reconcile_after?id:undefined;
   if(r.status==='expired'){
    // The old release could bind a session to a retired row and return its URL.
    // The first capture takes precedence over an unpaid replacement. A later capture
    // against either retired row stays separate and goes back to its original card.
    const replacement=(await db.query<Pick<PassCheckoutRow,'id'|'status'|'payment_id'>>(`SELECT id,status,payment_id FROM app_pass_checkout
     WHERE userid=$1 AND valid_date=$2 AND id<>$3 AND status NOT IN ('expired','cancelled') FOR UPDATE`,[r.userid,r.valid_date,r.id])).rows[0];
    if(replacement){
     if(replacement.status==='pending'&&!replacement.payment_id){
      await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1",[replacement.id]);
     }else{
      await this.recordUnissuedPayment(db,r,s.id,true);
      return id;
     }
    }
   }
   if(!this.visitEnded(r)&&await this.hasDeskPass(db,r)){
    await this.recordUnissuedPayment(db,r,s.id);
    return id;
   }
   // Commit the captured charge and webhook receipt without granting access.
   const payment=await new StaffModel(db,this.zone).createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),
    'paid','card',s.id,'Online day pass',r.userid);
   await db.query("UPDATE app_pass_checkout SET status='pending',payment_id=$2,refund_reconcile_after=now() WHERE id=$1",[id,payment]);
   return id;
  });
  if(refundCheckout)await this.reconcileRefund(refundCheckout);
 }
}
