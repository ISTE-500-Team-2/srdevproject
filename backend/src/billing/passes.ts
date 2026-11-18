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
 cancel_requested_at:Date|null;refund_id:string|null;refund_status:string|null;refund_needs_review:boolean;refund_review_inconsistent:boolean;refund_reconcile_after:Date|null;checkout_has_expiry:boolean;checkout_email:string|null;checkout_expires_at:Date|null;created_at:Date;}
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
// A legacy request could start near the end of its retry window, then stay open for another day.
const RETIRED_SESSION_WINDOW=CHECKOUT_RETRY_WINDOW+CHECKOUT_ABANDONMENT_WINDOW;
const CHECKOUT_SEARCH_PAGES=3;
const HONORED_REFUND_CAP_DAYS=30;
const refundPending=(f:{status?:string|null})=>f.status==='pending'||f.status==='requires_action';
const sameRefund=(a:Stripe.Refund,b:Stripe.Refund)=>a.id===b.id&&a.status===b.status&&a.amount===b.amount&&
 a.currency===b.currency&&objectId(a.payment_intent)===objectId(b.payment_intent)&&objectId(a.charge)===objectId(b.charge);
const tooLateToCreate=(expiry:Date)=>Math.floor(expiry.getTime()/1000)*1000-Date.now()<STRIPE_MIN_WINDOW;
const reviewRequired=(staffReview=false)=>new AppError(409,'RECONCILE_REQUIRED',staffReview
 ?'Check the original charge in Stripe. Wait for any pending refunds to finish. To issue an eligible held pass, choose Honor the visit. If you need to return the rest of a partial refund, refund it in Stripe and complete the review here.'
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
   const earlierCapture=(await db.query<{refund_needs_review:boolean}>(`SELECT refund_needs_review FROM app_pass_checkout
    WHERE userid=$1 AND valid_date=$2 AND status IN ('expired','cancelled') AND pass_id IS NULL AND payment_intent IS NOT NULL
     AND refund_status IS DISTINCT FROM 'succeeded' AND (refund_needs_review OR refund_reconcile_after IS NOT NULL)
    ORDER BY refund_needs_review DESC LIMIT 1`,[userid,date])).rows[0];
   if(earlierCapture?.refund_needs_review)throw reviewRequired();
   if(earlierCapture)throw new AppError(409,'PAYMENT_PROCESSING','The original payment is being verified. Refresh shortly.');
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
  if(row.refund_needs_review)throw reviewRequired();
  if(row.payment_id||row.refund_reconcile_after)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
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
    s=await this.findMemberCheckoutSession(row);
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
     s=await this.findMemberCheckoutSession(row);
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
  if(s.status!=='open'||!s.url){
   await this.queueObservedCapture(row,s);
   throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
  }
  return {checkoutUrl:s.url};
 }
 private async findMemberCheckoutSession(row:PassCheckoutRow){
  try{
   return await this.findCheckoutSession(row);
  }catch(error){
   if(error instanceof AppError&&error.code==='CHECKOUT_SEARCH_LIMIT')
    await this.pool.query(`UPDATE app_pass_checkout SET refund_reconcile_after=now()
     WHERE id=$1 AND status='pending' AND NOT refund_needs_review AND refund_reconcile_after IS NULL`,[row.id]);
   throw error;
  }
 }
 private async queueObservedCapture(row:PassCheckoutRow,s:Stripe.Checkout.Session){
  if(s.status!=='complete'||s.payment_status!=='paid')return;
  this.assertCheckoutSession(row,s);
  const pi=objectId(s.payment_intent);
  if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment missing.');
  await this.pool.query(`UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3,refund_reconcile_after=COALESCE(refund_reconcile_after,now())
   WHERE id=$1 AND payment_id IS NULL AND (checkout_id IS NULL OR checkout_id=$2) AND (payment_intent IS NULL OR payment_intent=$3)`,[row.id,s.id,pi]);
 }
 private async findCheckoutSession(row:PassCheckoutRow){
  const sdk=this.provider().sdk;
  const started=Math.floor(row.created_at.getTime()/1000);
  // An old request can start up to 23 hours after checkout creation. Allow a minute of clock skew.
  const params:Stripe.Checkout.SessionListParams={limit:100,created:{gte:started-60,lte:started+CHECKOUT_RETRY_WINDOW/1000+60}};
  for(let i=0;i<CHECKOUT_SEARCH_PAGES;i++){
   const page=await sdk.checkout.sessions.list(params,{maxNetworkRetries:0});
   const s=page.data.find(session=>session.client_reference_id===row.id&&session.metadata?.dayPassCheckoutId===row.id);
   if(s){
    if(s.livemode||s.mode!=='payment'||s.amount_total!==row.amount_cents||s.currency!=='usd')
     throw new AppError(400,'PAYMENT_MISMATCH','Day-pass payment does not match checkout.');
    return s;
   }
   if(!page.has_more)return;
   params.starting_after=page.data.at(-1)?.id;
   if(!params.starting_after)break;
  }
  // A truncated search cannot establish that it is safe to replace the checkout.
  throw new AppError(409,'CHECKOUT_SEARCH_LIMIT','The original card checkout could not be verified. Contact staff.');
 }
 private async expireUnpaidCheckout(id:string,unbound=false){
  return this.pool.query(`UPDATE app_pass_checkout SET status='expired',refund_reconcile_after=CASE WHEN $2 THEN now() END
   WHERE id=$1 AND status='pending' AND payment_id IS NULL AND refund_reconcile_after IS NULL AND (NOT $2 OR checkout_id IS NULL)`,[id,unbound]);
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
  const reason=duplicateCheckout?'This checkout was replaced or another checkout already covered this visit. No pass was issued for this payment.'
   :'You already had a day pass for this date, so this payment did not buy a second one.';
  const model=new StaffModel(db,this.zone),amount=(r.amount_cents/100).toFixed(2);
  const payment=r.payment_id??await model.createPayment(r.userid,null,amount,'paid','card',reference,'Online day pass (not issued)',r.userid);
  await db.query("UPDATE app_pass_checkout SET payment_id=$2,status=$3,cancel_requested_at=COALESCE(cancel_requested_at,now()),refund_reconcile_after=now() WHERE id=$1",
   [r.id,payment,duplicateCheckout?'cancelled':'paid']);
  await model.audit(r.userid,r.userid,'daypass.not_issued','payment',payment,reason,null,{checkoutId:r.id,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:'daypass-not-issued:'+r.id,payload:{paymentId:payment,amount,currency:'USD',
   method:'Card (test mode)',reference,planName:r.plan_snapshot.name,validDate:new Date(r.valid_date).toISOString().slice(0,10),instructions:reason+' We are refunding it to your original card.'}});
 }
 /** Recover captures, retired sessions and refunds even when Stripe's event reaches the previous release. */
 async reconcileRefunds(){
  if(!this.stripe)return;
  await this.flagPaymentAnomalies();
  // Claim a bounded batch across replicas. Interrupted claims become due again in a minute.
  const rows=(await this.pool.query<{id:string}>(`WITH due AS (
    SELECT id FROM app_pass_checkout WHERE refund_reconcile_after<=now()
     OR refund_reconcile_after IS NULL AND (
      refund_needs_review AND payment_id IS NULL AND (
       checkout_id IS NOT NULL AND payment_intent IS NOT NULL
       OR status='pending' AND checkout_id IS NULL AND payment_intent IS NULL)
      OR NOT refund_needs_review AND refund_status IN ('pending','requires_action'))
    ORDER BY refund_reconcile_after LIMIT 20 FOR UPDATE SKIP LOCKED
   ) UPDATE app_pass_checkout c SET refund_reconcile_after=now()+interval '1 minute'
   FROM due WHERE c.id=due.id RETURNING c.id`)).rows;
  await Promise.all(rows.map(({id})=>this.reconcileRefund(id).catch(error=>
   console.error('Day-pass refund reconciliation deferred',{checkoutId:id,...errorIdentifier(error)}))));
 }
 private async flagPaymentAnomalies(){
  const flagged=await this.pool.query<{id:string}>(`WITH candidates AS (
    SELECT c.id FROM app_pass_checkout c
    JOIN payment p ON p.paymentid=c.payment_id
    LEFT JOIN day_pass d ON d.dayid=c.pass_id
    WHERE NOT c.refund_needs_review AND c.amount_cents>0
     AND (EXISTS (SELECT 1 FROM payment other WHERE other.userid=c.userid AND other.paymentid<>p.paymentid
           AND other.method='card' AND other.paymentstatus IN ('paid','refunded')
           AND other.reference IN (c.checkout_id,c.payment_intent))
       OR c.pass_id IS NULL AND p.paymentstatus='paid' AND c.refund_reconcile_after IS NULL
       OR c.refund_status='succeeded' AND (d.status IN ('active','suspended') OR p.paymentstatus IS DISTINCT FROM 'refunded')
       OR d.status IN ('active','suspended') AND EXISTS (
          SELECT 1 FROM app_staff_audit a WHERE a.subject_id=c.userid AND a.action='daypass.checkout.retired'
           AND a.after_state->>'retiredCheckoutId'=c.id::text)
        AND NOT EXISTS (SELECT 1 FROM app_staff_audit a WHERE a.subject_id=c.userid AND a.entity_type='payment'
           AND a.entity_id=c.payment_id AND a.action='billing.refund.reviewed'
           AND a.after_state->>'checkoutId'=c.id::text AND a.after_state->>'keptPassId'=c.pass_id::text))
    ORDER BY p.paymentdate,c.id LIMIT 20 FOR UPDATE OF c SKIP LOCKED
   ) UPDATE app_pass_checkout c SET refund_needs_review=true,refund_review_inconsistent=false FROM candidates WHERE c.id=candidates.id RETURNING c.id`);
  for(const {id} of flagged.rows)
   console.error('Day-pass payment requires staff reconciliation',{checkoutId:id,code:'RECONCILE_REQUIRED'});
 }
 private async deferReconciliation(id:string,token:string,error:unknown){
  const terminal=error instanceof AppError&&(error.status===400||error.code==='CHECKOUT_SEARCH_LIMIT')||
   error instanceof Stripe.errors.StripeInvalidRequestError||error instanceof Stripe.errors.StripeAuthenticationError||
   error instanceof Stripe.errors.StripePermissionError;
  // Lock in the same order as issuance and preserve a newer claim or a successful retry.
  const stopped=await transaction(this.pool,async db=>{
   const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE id=$1',[id])).rows[0];
   if(!owner)return false;
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const row=(await db.query<PassCheckoutRow>(`SELECT * FROM app_pass_checkout WHERE id=$1
    AND refund_reconcile_after=$2::timestamptz FOR UPDATE`,[id,token])).rows[0];
   if(!row)return false;
   // A truncated search proves nothing. Keep unbound pending checkouts queued at a low cadence.
   if(row.status==='pending'&&!row.checkout_id&&!row.payment_intent&&!row.payment_id&&
      (row.refund_needs_review||error instanceof AppError&&error.code==='CHECKOUT_SEARCH_LIMIT')){
    await db.query("UPDATE app_pass_checkout SET refund_needs_review=true,refund_review_inconsistent=false,refund_reconcile_after=now()+interval '1 hour' WHERE id=$1",[id]);
    return false;
   }
   const result=await db.query<{due:Date|null}>(`WITH retry_window AS (
     SELECT COALESCE(honor.created_at,GREATEST(c.created_at,p.paymentdate AT TIME ZONE 'UTC')) AS started,
      CASE WHEN honor.created_at IS NULL THEN $3*interval '1 second' ELSE $4*interval '1 day' END AS duration
     FROM app_pass_checkout c LEFT JOIN payment p ON p.paymentid=c.payment_id
     LEFT JOIN LATERAL (
      SELECT created_at FROM app_staff_audit WHERE c.refund_status='partial' AND subject_id=c.userid AND entity_id=c.payment_id
       AND action='billing.refund.reviewed' AND after_state->>'checkoutId'=c.id::text AND after_state ? 'refundIds'
      ORDER BY id DESC LIMIT 1
     ) honor ON true WHERE c.id=$1
    ) SELECT CASE WHEN NOT $2 AND now()<started+duration THEN LEAST(started+duration,now()+CASE
      WHEN now()<started+interval '1 hour' THEN interval '1 minute'
      WHEN now()<started+interval '6 hours' THEN interval '15 minutes'
      ELSE interval '1 hour' END) END AS due FROM retry_window`,
    [id,terminal,RETIRED_SESSION_WINDOW/1000,HONORED_REFUND_CAP_DAYS]);
   const due=result.rows[0]!.due;
   if(due)await db.query('UPDATE app_pass_checkout SET refund_reconcile_after=$2 WHERE id=$1',[id,due]);
   else await this.escalateCheckout(db,row);
   return !due;
  });
  if(stopped)console.error('Day-pass reconciliation stopped for staff review',{checkoutId:id,...errorIdentifier(error)});
 }
 private async escalateCheckout(db:Database,r:PassCheckoutRow){
  // Only a verified paid session has both IDs. Unknown captures remain in the operator query.
  const payment=r.payment_id??(r.payment_intent&&r.checkout_id
   ?await new StaffModel(db,this.zone).createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),'paid','card',
    r.checkout_id,'Online day pass awaiting reconciliation',r.userid)
   :null);
  await db.query(`UPDATE app_pass_checkout SET payment_id=$2,refund_needs_review=true,refund_review_inconsistent=false,refund_reconcile_after=NULL WHERE id=$1`,[r.id,payment]);
 }
 private async reconcileRefund(id:string){
  let token:string|undefined;
  const followUp=await providerTransaction(this.pool,async db=>{
   const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE id=$1',[id])).rows[0];
   if(!owner)return;
   // Use the same lock as both releases and desk sales.
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const row=(await db.query<PassCheckoutRow&{retry_token:string}>(`SELECT *,refund_reconcile_after::text AS retry_token FROM app_pass_checkout
    WHERE id=$1 AND refund_reconcile_after IS NOT NULL FOR UPDATE`,[id])).rows[0];
   if(!row)return;
   token=row.retry_token;
   return this.reconcileCheckoutRefund(db,row);
  }).catch(async error=>{
   if(token)await this.deferReconciliation(id,token,error);
   throw error;
  });
  if(followUp==='continue')await this.reconcileRefund(id);
  else if(followUp)await this.reconcileRefund(followUp.retired).catch(error=>
   console.error('Retired day-pass checkout reconciliation deferred',{checkoutId:followUp.retired,...errorIdentifier(error)}));
 }
 private async reconcileCheckoutRefund(db:Database,r:PassCheckoutRow):Promise<'continue'|{retired:string}|undefined>{
  const {id}=r;
  if(r.refund_needs_review&&!r.payment_id&&r.payment_intent&&r.checkout_id){
   await this.escalateCheckout(db,r);
   return;
  }
  if(!r.payment_intent||!r.payment_id&&!r.checkout_id){
   const session=await this.reconcileSession(r);
   if(!session){
    // A complete search after the last possible session expired can release an unbound checkout.
    if(r.status==='pending'&&!r.checkout_id&&!r.payment_intent&&!r.payment_id&&
       (await db.query(`UPDATE app_pass_checkout SET status='expired',refund_needs_review=false,refund_reconcile_after=NULL
        WHERE id=$1 AND now()>=created_at+$2*interval '1 second'`,[id,RETIRED_SESSION_WINDOW/1000])).rowCount)return;
    // An in-flight create can still bind after retirement. Slow down discovery as the row ages.
    const result=await db.query<{refund_reconcile_after:Date|null}>(`UPDATE app_pass_checkout SET
     refund_needs_review=refund_needs_review OR now()>=created_at+$2*interval '1 second',
     refund_reconcile_after=CASE WHEN now()<created_at+$2*interval '1 second' THEN
      LEAST(created_at+$2*interval '1 second',now()+CASE
       WHEN now()<created_at+interval '1 hour' THEN interval '5 minutes'
       WHEN now()<created_at+interval '6 hours' THEN interval '30 minutes'
       ELSE interval '2 hours' END) END WHERE id=$1 RETURNING refund_reconcile_after`,[id,RETIRED_SESSION_WINDOW/1000]);
    if(result.rows[0]?.refund_reconcile_after===null)
     console.error('Day-pass checkout session not found before reconciliation deadline',{checkoutId:id,code:'RECONCILE_REQUIRED'});
    return;
   }
   if(session.status!=='complete'||session.payment_status!=='paid'){
    await db.query(`UPDATE app_pass_checkout SET checkout_id=$2,
     status=CASE WHEN status='pending' AND $3='expired' THEN 'expired' ELSE status END,
     refund_needs_review=refund_needs_review AND NOT (status='pending' AND payment_id IS NULL AND payment_intent IS NULL AND $3 IN ('open','expired')),
     refund_reconcile_after=NULL WHERE id=$1`,[id,session.id,session.status]);
    return;
   }
   const pi=objectId(session.payment_intent);
   if(!pi||r.payment_intent&&r.payment_intent!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment does not match checkout.');
   // Commit the identity before taking a refund snapshot so a concurrent new webhook
   // can find the checkout and wait for this member's issuance transaction.
   await db.query('UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3 WHERE id=$1',[id,session.id,pi]);
   return 'continue';
  }
  let retired:string|undefined;
  // An outage leaves the binding and queue durable. Delay writing the ledger until after this
  // lookup because the previous webhook ignores a payment_id when pass_id is still NULL.
  const refunds=await this.refundSnapshot(r);
  if(!r.payment_id){
   const model=new StaffModel(db,this.zone);
   const replacement=r.status==='expired'?(await db.query<Pick<PassCheckoutRow,'id'|'status'|'payment_id'>>(`SELECT id,status,payment_id FROM app_pass_checkout
    WHERE userid=$1 AND valid_date=$2 AND id<>$3 AND status NOT IN ('expired','cancelled') FOR UPDATE`,[r.userid,r.valid_date,id])).rows[0]:undefined;
   const superseded=r.status==='expired'&&await this.wasRetired(db,r);
   const duplicate=!!superseded||!!replacement&&(replacement.status!=='pending'||!!replacement.payment_id);
   if(duplicate||!this.visitEnded(r)&&await this.hasDeskPass(db,r)){
    await this.recordUnissuedPayment(db,r,r.checkout_id??r.payment_intent,duplicate||!!replacement);
    // Keep the charge and retry deadline if Stripe loses the refund response.
    return 'continue';
   }
   const payment=await model.createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),'paid','card',r.checkout_id??r.payment_intent,'Online day pass',r.userid);
   if(replacement){
    retired=replacement.id;
    await db.query("UPDATE app_pass_checkout SET status='expired',refund_reconcile_after=now() WHERE id=$1",[retired]);
    await model.audit(r.userid,r.userid,'daypass.checkout.retired','payment',payment,'An earlier checkout was paid',null,
     {checkoutId:id,retiredCheckoutId:retired});
   }
   await db.query("UPDATE app_pass_checkout SET status='pending',payment_id=$2 WHERE id=$1",[id,payment]);
   r={...r,status:'pending',payment_id:payment};
  }
  let outcome=await this.observeRefunds(db,r,refunds);
  const refundingUnissued=canRetryUnissuedRefund(r);
  if(!outcome&&refundingUnissued&&!r.refund_needs_review&&!r.refund_id)
   outcome=await this.submitRefund(db,r,refunds);
  const pending=refunds.data.some(refundPending)||!!outcome&&outcome!=='review'&&outcome!=='split'&&refundPending(outcome);
  // submitRefund saw Stripe confirm the refund while its reads disagreed: keep rechecking until they agree.
  const unrecorded=!!outcome&&outcome!=='review'&&outcome!=='split'&&outcome.status==='needs_review';
  const monitoring=r.refund_status==='partial'&&outcome!=='split'&&
   (outcome==='review'||outcome?.status!=='succeeded');
  if(pending||refunds.inconsistent||unrecorded){
   await this.scheduleRefundCheck(db,r);
  }else if(monitoring){
   await db.query(`UPDATE app_pass_checkout SET refund_reconcile_after=(
    SELECT LEAST(now()+interval '5 minutes',created_at+interval '3 days')
    FROM app_staff_audit WHERE subject_id=$2 AND entity_id=$3 AND action='billing.refund.reviewed'
     AND after_state->>'checkoutId'=$1::text AND after_state ? 'refundIds'
     AND created_at>now()-interval '3 days' ORDER BY id DESC LIMIT 1
   ) WHERE id::text=$1`,[id,r.userid,r.payment_id]);
  }else{
   if(refundingUnissued&&(!outcome||outcome!=='review'&&outcome!=='split'&&failedRefund(outcome)))
    await this.flagRefundReview(db,r);
   if(!outcome&&!r.refund_needs_review&&!r.pass_id&&r.status==='pending'){
    if(this.visitEnded(r)){
     // Rollback can leave manual admissions in the shift log only.
     await this.flagRefundReview(db,r);
    }else if(await this.hasDeskPass(db,r)){
     await this.recordUnissuedPayment(db,r,r.checkout_id??r.payment_intent!);
     return 'continue';
    }else{
     await this.issue(db,r,r.checkout_id??r.payment_intent!);
    }
   }
   await db.query('UPDATE app_pass_checkout SET refund_reconcile_after=NULL WHERE id=$1',[id]);
  }
  return retired?{retired}:undefined;
 }
 private assertCheckoutSession(r:PassCheckoutRow,s:Stripe.Checkout.Session){
  if(s.livemode||s.mode!=='payment'||s.metadata?.dayPassCheckoutId!==r.id||s.client_reference_id!==r.id||
     r.checkout_id&&s.id!==r.checkout_id||s.amount_total!==r.amount_cents||s.currency!=='usd')
   throw new AppError(400,'PAYMENT_MISMATCH','Day-pass payment does not match checkout.');
 }
 private async reconcileSession(r:PassCheckoutRow){
  const sessions=this.provider().sdk.checkout.sessions;
  let session=r.checkout_id?await sessions.retrieve(r.checkout_id):await this.findCheckoutSession(r);
  if(!session)return;
  this.assertCheckoutSession(r,session);
  if(r.status==='expired'&&session.status==='open'){
   try{
    session=await sessions.expire(session.id);
   }catch(error){
    if(!(error instanceof Stripe.errors.StripeInvalidRequestError))throw error;
    // Stripe rejects expiration if completion or automatic expiry won the race.
    session=await sessions.retrieve(session.id);
    if(session.status==='open')throw error;
   }
   this.assertCheckoutSession(r,session);
  }
  return session;
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
   if(r.status==='pending'&&r.refund_reconcile_after)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh after verification before cancelling.');
   if(r.status==='paid'&&!r.cancel_requested_at&&!r.timely)throw new AppError(409,'CANCELLATION_NOTICE','Day passes require at least 3 days cancellation notice.');
   await db.query("UPDATE app_pass_checkout SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1 AND status='paid'",[id]);return r;
  });
  if(row.status==='expired'||row.status==='cancelled'&&!canRetryUnissuedRefund(row))return {cancelled:true,...unissued(row)};
  if(row.status==='pending'){
   if(row.payment_id||row.refund_reconcile_after)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh after verification before cancelling.');
   const sdk=this.provider().sdk;
   let s:Stripe.Checkout.Session|undefined;
   if(row.checkout_id){
    s=await sdk.checkout.sessions.retrieve(row.checkout_id);
   }else{
    const legacyToday=!row.checkout_expires_at&&new Date(row.valid_date).toISOString().slice(0,10)===businessToday(this.zone);
    if(!legacyToday&&Date.now()-row.created_at.getTime()<CHECKOUT_ABANDONMENT_WINDOW)throw new AppError(409,'RECONCILE_REQUIRED','Resume checkout before cancelling.');
    s=await this.findMemberCheckoutSession(row);
    if(!s&&(await this.expireUnpaidCheckout(id,true)).rowCount)return {cancelled:true};
    if(!s)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
   }
   if(s.status==='open')s=await sdk.checkout.sessions.expire(s.id);
   if(s.status!=='expired'){
    await this.queueObservedCapture(row,s);
    throw new AppError(409,'PAYMENT_PROCESSING','Payment completed. Refresh after verification before cancelling.');
   }
   await this.pool.query("UPDATE app_pass_checkout SET status='expired',cancel_requested_at=NULL WHERE id=$1 AND status='pending' AND payment_id IS NULL AND refund_reconcile_after IS NULL",[id]);return {cancelled:true};
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
  const list=await this.refundSnapshot(r);
  const outcome=await this.observeRefunds(db,r,list);
  if(list.data.some(refundPending))await this.scheduleRefundCheck(db,r);
  if(outcome==='review'||(outcome&&outcome!=='split'&&'refundIds' in outcome))return {id:null,status:'needs_review'};
  if(outcome==='split')return {id:null,status:'succeeded'};
  return outcome??await this.submitRefund(db,r,list);
 }
 /** Only called after Stripe shows that none of the charge has been refunded. */
 private async submitRefund(db:Database,r:PassCheckoutRow,list:Stripe.ApiList<Stripe.Refund>){
  const attempt=refundAttempt('daypass-refund:'+r.id,list);
  const f=await this.provider().sdk.refunds.create({payment_intent:r.payment_intent!,amount:r.amount_cents,...(attempt.metadata?{metadata:attempt.metadata}:{})},
   {idempotencyKey:attempt.key});
  if(f.status==='succeeded'&&!sameRefund(f,await this.provider().sdk.refunds.retrieve(f.id))){
   await db.query('UPDATE app_pass_checkout SET refund_id=$2,refund_status=NULL WHERE id=$1',[r.id,f.id]);
   await this.flagRefundReview(db,r,true);
   // Stripe confirmed the refund, but its reads lag. Keep checking so the pass is cancelled once they agree.
   await this.scheduleRefundCheck(db,r,true);
   return {id:f.id,status:'needs_review'};
  }
  await this.applyRefund(db,f);
  if(refundPending(f))await this.scheduleRefundCheck(db,r);
  return f;
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
   if(r.amount_cents===0||!r.payment_intent||!r.payment_id||r.status==='expired'&&!review)
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
    const list=await this.refundSnapshot(r);
    const usablePass=!!r.pass_id&&(await db.query(`SELECT 1 FROM day_pass WHERE dayid=$1 AND status IN ('active','suspended')`,[r.pass_id])).rowCount;
    const outcome=await this.observeRefunds(db,r,list,verifiedCharge,true);
    if(list.data.some(refundPending)){
     await this.scheduleRefundCheck(db,r);
     return {status:'needs_review'};
    }
    if(outcome==='review'||(outcome&&outcome!=='split'&&outcome.status!=='succeeded'&&!('refundIds' in outcome)))
     return {status:'needs_review'};
    const fullyRefunded=outcome==='split'||outcome?.status==='succeeded';
    const partial=outcome&&outcome!=='split'&&'refundIds' in outcome?outcome:undefined;
    const retired=await this.wasRetired(db,r);
    const matchingPayments=(await db.query<{paymentid:number;detached:boolean}>(`SELECT p.paymentid,p.membershipid IS NULL
      AND NOT EXISTS (SELECT 1 FROM day_pass WHERE paymentid=p.paymentid)
      AND NOT EXISTS (SELECT 1 FROM app_pass_checkout WHERE payment_id=p.paymentid)
      AND NOT EXISTS (SELECT 1 FROM app_membership_invoice WHERE payment_id=p.paymentid)
      AND NOT EXISTS (SELECT 1 FROM reservation WHERE payment_id=p.paymentid)
      AND NOT EXISTS (SELECT 1 FROM app_equipment_checkout WHERE payment_id=p.paymentid)
      AND NOT EXISTS (SELECT 1 FROM app_training_enrollment WHERE payment_id=p.paymentid) AS detached
     FROM payment p WHERE p.paymentid=$2 OR (p.userid=$1 AND p.method='card' AND p.paymentstatus IN ('paid','refunded')
      AND p.reference IN ($3,$4)) ORDER BY p.paymentdate,p.paymentid FOR UPDATE`,[r.userid,r.payment_id,r.checkout_id,r.payment_intent])).rows;
    const duplicates=matchingPayments.filter(p=>p.paymentid!==r.payment_id);
    if(duplicates.some(p=>!p.detached))
     throw new AppError(409,'RECONCILE_REQUIRED','A matching Stripe ledger entry is linked to another record. Ask the payments owner to correct the ledger before completing review.');
    const requiresAcceptance=!!usablePass&&(retired||duplicates.length>0);
    const canIssue=!r.pass_id&&(r.status==='pending'||r.status==='expired')&&!retired&&!this.visitEnded(r)&&
     !await this.hasDeskPass(db,r)&&!(await db.query(`SELECT 1 FROM app_pass_checkout
      WHERE userid=$1 AND valid_date=$2 AND id<>$3 AND status NOT IN ('expired','cancelled')`,[r.userid,r.valid_date,id])).rowCount;
    const keepExisting=!!usablePass&&!fullyRefunded&&honorVisit;
    let passIssued=false;
    if(!fullyRefunded&&(partial||requiresAcceptance||canIssue||keepExisting)){
     if(!honorVisit||!verifiedCharge)return {status:'needs_review'};
     if(canIssue){
      await this.issue(db,r,r.checkout_id??r.payment_intent);
      passIssued=true;
     }else if(!usablePass)return {status:'needs_review'};
    }else if(!fullyRefunded&&!r.pass_id){
     // Staff may retain the charge after reviewing an admission or close the
     // unused visit before issuing a refund. Keep a closed entitlement linked
     // to the charge so the old handler cannot issue a new pass for it.
     const pass=await model.createPass(r.userid,r.plan_snapshot,new Date(r.valid_date).toISOString().slice(0,10),actor,explanation,'cancelled');
     await model.linkPassPayment(pass,r.payment_id);
     await db.query("UPDATE app_pass_checkout SET status='cancelled',pass_id=$2,cancel_requested_at=NULL WHERE id=$1",[id,pass]);
    }
    // Rollback can replace the checkout's payment link. Keep the original
    // ledger date and move the entitlement link back before voiding duplicates.
    const originalPaymentId=matchingPayments[0]!.paymentid;
    if(originalPaymentId!==r.payment_id){
     const {pass_id}=(await db.query<{pass_id:number|null}>(
      'UPDATE app_pass_checkout SET payment_id=$2 WHERE id=$1 RETURNING pass_id',[id,originalPaymentId])).rows[0]!;
     if(pass_id)await model.linkPassPayment(pass_id,originalPaymentId);
     if(!fullyRefunded)
      await db.query("UPDATE payment SET paymentstatus='paid',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus='refunded'",[originalPaymentId]);
    }
    if(fullyRefunded)await this.settleRefundLedger(db,{...r,payment_id:originalPaymentId});
    const voidPaymentIds=matchingPayments.filter(p=>p.paymentid!==originalPaymentId).map(p=>p.paymentid);
    if(voidPaymentIds.length)
     await db.query("UPDATE payment SET paymentstatus='void',updated_at=now(),revision=revision+1 WHERE paymentid=ANY($1::int[])",[voidPaymentIds]);
    await db.query(`UPDATE app_pass_checkout SET refund_needs_review=false,refund_review_inconsistent=false,
     refund_id=CASE WHEN $2 THEN NULL ELSE refund_id END,
     refund_status=CASE WHEN $2 THEN 'partial' WHEN refund_status='partial' THEN NULL ELSE refund_status END,
     refund_reconcile_after=CASE WHEN $2 THEN now()+interval '5 minutes' END WHERE id=$1`,[id,!!partial]);
    const settlement=partial?{refundIds:partial.refundIds,refundedCents:partial.amount,retainedCents:r.amount_cents-partial.amount}:{};
    const passCancelled=!!usablePass&&fullyRefunded;
    await model.audit(actor,r.userid,'billing.refund.reviewed','payment',originalPaymentId,explanation,null,{
     checkoutId:id,...settlement,...(keepExisting?{keptPassId:r.pass_id}:{}),
     ...(passCancelled?{cancelledPassId:r.pass_id}:{}),...(voidPaymentIds.length?{voidPaymentIds}:{}),
    });
    return {status:'reviewed',...(passIssued?{passIssued:true}:{}),...(passCancelled?{passCancelled:true}:{}),
     ...(keepExisting?{passKept:true}:{})};
   }
   const f=await this.cardRefund(db,r);
   if(f.status!=='needs_review')await model.audit(actor,r.userid,'billing.refund.requested','payment',r.payment_id,explanation,null,{refundId:f.id,status:f.status});
   return {status:f.status};
  });
  if(result.status==='needs_review')throw reviewRequired(review);
  return result;
 }
 private async wasRetired(db:Database,r:PassCheckoutRow){
  return !!(await db.query(`SELECT 1 FROM app_staff_audit WHERE subject_id=$1
   AND action='daypass.checkout.retired' AND after_state->>'retiredCheckoutId'=$2 LIMIT 1`,[r.userid,r.id])).rowCount;
 }
 async finishCancel(db:Database,r:Pick<PassCheckoutRow,'id'|'pass_id'|'cancel_requested_at'>){
  await db.query("UPDATE app_pass_checkout SET status='cancelled' WHERE id=$1 AND status<>'cancelled'",[r.id]);
  // Without the member's own request, the refund came from staff or Stripe.
  await db.query("UPDATE day_pass SET status='cancelled',statusdesc=$2,revision=revision+1 WHERE dayid=$1 AND status IS DISTINCT FROM 'cancelled'",
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
  }
  await this.settleRefundLedger(db,r);
  const refund=refundIds.length===1?{refundId:refundIds[0]}:{refundIds};
  await new StaffModel(db).audit(r.userid,r.userid,'daypass.refunded','payment',r.payment_id!,'Original-card refund confirmed',null,{...refund,amount:r.amount_cents});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_refunded',dedupeKey:'daypass-refund:'+r.id+':'+dedupeSuffix,
   payload:{reference,amount:(r.amount_cents/100).toFixed(2),currency:'USD',method:'Original card (test mode)'}});
 }
 private async settleRefundLedger(db:Database,r:PassCheckoutRow){
  await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1 AND paymentstatus IS DISTINCT FROM 'refunded'",[r.payment_id]);
  await this.finishCancel(db,r);
 }
 /**
  * inconsistent: raised only because Stripe's reads disagree, so a later consistent read that records the
  * full refund settles it (see settleInconsistentReview). Any other reason keeps the review for staff.
  */
 private async flagRefundReview(db:Database,r:PassCheckoutRow,inconsistent=false){
  const raised=await db.query(`UPDATE app_pass_checkout SET refund_needs_review=true,refund_review_inconsistent=$2 AND NOT refund_needs_review
   WHERE id=$1 AND (NOT refund_needs_review OR refund_review_inconsistent AND NOT $2)`,[r.id,inconsistent]);
  if(raised.rowCount&&!r.refund_needs_review)
   console.error('Day-pass refund requires staff reconciliation',{checkoutId:r.id,code:'RECONCILE_REQUIRED'});
 }
 /** A full refund recorded from reads that agree settles a review raised only because earlier reads disagreed. */
 private async settleInconsistentReview(db:Database,r:PassCheckoutRow){
  await db.query(`UPDATE app_pass_checkout SET refund_needs_review=false,refund_review_inconsistent=false
   WHERE id=$1 AND refund_needs_review AND refund_review_inconsistent`,[r.id]);
 }
 /** Reconcile against the whole payment. A webhook's individual refund can already be superseded. */
 private async observeRefunds(db:Database,r:PassCheckoutRow,list:Stripe.ApiList<Stripe.Refund>&{inconsistent:boolean},verifiedCharge?:string,staffReview=false):
  Promise<'review'|'split'|Pick<Stripe.Refund,'id'|'status'>|{status:'partial';amount:number;refundIds:string[]}|undefined>{

  if(list.inconsistent){
   await this.flagRefundReview(db,r,true);
   // Stripe's reads disagree for now. The flag alone would leave a confirmed refund's pass active,
   // so recheck automatically: a consistent read records the refund and cancels the pass.
   await this.scheduleRefundCheck(db,r,true);
   return 'review';
  }
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
    await this.settleInconsistentReview(db,r);
    return settled[0]!;
   }
   // Replace a previously recorded full refund ID too, so a delayed failure
   // of that refund cannot undo its successful replacements.
   if(r.refund_status!=='succeeded'||r.refund_id){
    await db.query("UPDATE app_pass_checkout SET refund_id=NULL,refund_status='succeeded' WHERE id=$1",[r.id]);
    await this.recordConfirmedRefund(db,r,r.payment_intent!,settled.map(f=>f.id).sort(),'split');
   }
   await this.settleInconsistentReview(db,r);
   return 'split';
  }
  if(complete&&total>0&&total<r.amount_cents&&settled.length===live.length&&r.refund_status!=='succeeded'){
   const refundIds=settled.map(f=>f.id).sort();
   if(verifiedCharge&&live.every(f=>objectId(f.charge)===verifiedCharge)&&(!r.refund_id||list.data.some(f=>f.id===r.refund_id)))
    return {status:'partial',amount:total,refundIds};
   if(r.refund_status==='partial'){
    const accepted=(await db.query<{refund_ids:string[];amount:number}>(`SELECT after_state->'refundIds' AS refund_ids,
      (after_state->>'refundedCents')::int AS amount FROM app_staff_audit
      WHERE subject_id=$1 AND entity_id=$2 AND action='billing.refund.reviewed' AND after_state->>'checkoutId'=$3
        AND after_state ? 'refundIds' ORDER BY id DESC LIMIT 1`,[r.userid,r.payment_id,r.id])).rows[0];
    if(accepted?.amount===total&&JSON.stringify(accepted.refund_ids)===JSON.stringify(refundIds))
     return {status:'partial',amount:total,refundIds};
   }
  }
  const recordedFailure=list.data.find(f=>f.id===r.refund_id&&failedRefund(f));
  if(complete&&live.length===0&&(r.refund_status!=='succeeded'||recordedFailure)&&
     (r.refund_status!=='partial'||staffReview)){
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
 /** keepEarlier: queue a check without postponing one that is already due sooner. */
 private async scheduleRefundCheck(db:Database,r:PassCheckoutRow,keepEarlier=false){
  // Continue tracking a known pending refund after the honor window, at a
  // lower cadence. Successful reads do not turn a pending refund terminal.
  await db.query(`UPDATE app_pass_checkout SET refund_reconcile_after=CASE WHEN $6 THEN LEAST(refund_reconcile_after,next) ELSE next END
   FROM (SELECT now()+CASE WHEN $2='partial' AND EXISTS (
    SELECT 1 FROM app_staff_audit WHERE subject_id=$3 AND entity_id=$4 AND action='billing.refund.reviewed'
     AND after_state->>'checkoutId'=$1::text AND after_state ? 'refundIds' AND created_at>now()-$5*interval '1 day'
   ) THEN interval '5 minutes' WHEN $2='partial' THEN interval '1 day' ELSE interval '1 minute' END AS next) due
   WHERE id::text=$1`,[r.id,r.refund_status,r.userid,r.payment_id,HONORED_REFUND_CAP_DAYS,keepEarlier]);
 }
 private async refundSnapshot(r:PassCheckoutRow,fresh?:Stripe.Refund){
  const sdk=this.provider().sdk;
  const list=await sdk.refunds.list({payment_intent:r.payment_intent!,limit:100});
  const recorded=list.data.find(f=>f.id===r.refund_id);
  const ids=new Set(list.data.filter(f=>f.status==='succeeded').map(f=>f.id));
  if(r.refund_id&&(!recorded||refundPending(recorded)))ids.add(r.refund_id);
  if(fresh)ids.add(fresh.id);
  let inconsistent=false;
  for(const id of ids){
   const current=fresh?.id===id?fresh:await sdk.refunds.retrieve(id);
   if(current.id!==id||objectId(current.payment_intent)!==r.payment_intent)
    throw new AppError(400,'PAYMENT_MISMATCH','Refund identity mismatch.');
   const listed=list.data.find(f=>f.id===id);
   if(!listed)list.data.push(current);
   else if(!sameRefund(listed,current))inconsistent=true;
  }
  return {...list,inconsistent};
 }
 async refundEvent(db:Database,obj:Stripe.Refund){
  const pi=objectId(obj.payment_intent);
  if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund payment intent missing.');
  const owner=(await db.query<{userid:number}>('SELECT userid FROM app_pass_checkout WHERE payment_intent=$1',[pi])).rows[0];
  if(!owner)return;
  await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
  const row=(await db.query<PassCheckoutRow>('SELECT * FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE',[pi])).rows[0]!;
  // Binding precedes recording the ledger. If this delivery got the member lock
  // first, leave its receipt uncommitted so Stripe can retry if the list lags.
  if(!row.payment_id)throw new AppError(503,'PAYMENT_PROCESSING','The original day-pass payment is being verified.');
  const sdk=this.provider().sdk,f=await sdk.refunds.retrieve(obj.id);
  if(f.id!==obj.id||objectId(f.payment_intent)!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Refund identity mismatch.');
  const list=await this.refundSnapshot(row,f);
  const outcome=await this.observeRefunds(db,row,list);
  if(list.data.some(refundPending)||outcome&&outcome!=='review'&&outcome!=='split'&&refundPending(outcome))
   await this.scheduleRefundCheck(db,row);
  else if(outcome==='split'||outcome&&outcome!=='review'&&outcome.status==='succeeded')
   await db.query('UPDATE app_pass_checkout SET refund_reconcile_after=NULL WHERE id=$1',[row.id]);
  else if(!outcome&&canRetryUnissuedRefund(row))await this.flagRefundReview(db,row);
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
   this.assertCheckoutSession(r,s);
   if(obj.status==='complete'&&obj.payment_status==='paid'&&(s.status!=='complete'||s.payment_status!=='paid'))
    throw new AppError(503,'PAYMENT_PROCESSING','The original day-pass payment is being verified.');
   if(s.status==='expired'){await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND payment_id IS NULL AND refund_reconcile_after IS NULL",[id]);return;}
   if(event.type==='checkout.session.async_payment_failed'&&s.payment_status==='unpaid'){
    const failed=await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending' AND payment_id IS NULL AND refund_reconcile_after IS NULL RETURNING id",[id]);
    if(failed.rowCount)await enqueueNotification(db,{userId:r.userid,kind:'payment_failed',dedupeKey:'pass-failed:'+id,
     payload:{reference:s.id,planName:r.plan_snapshot.name,instructions:'Your payment did not go through, so this day pass was not issued. Try again from Membership & passes.'}});
    return;
   }
   if(s.status!=='complete'||s.payment_status!=='paid')return;
   const pi=objectId(s.payment_intent);
   if(!pi||r.payment_intent&&r.payment_intent!==pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment does not match checkout.');
   if(r.payment_id)return r.refund_reconcile_after?id:undefined;
   // Commit the receipt and binding before the worker can take its refund snapshot.
   await db.query("UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3,refund_reconcile_after=now() WHERE id=$1",[id,s.id,pi]);
   return id;
  });
  if(refundCheckout)await this.reconcileRefund(refundCheckout);
 }
}
