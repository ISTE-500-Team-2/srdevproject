import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {transaction,type Database} from '../db.js';
import {AppError,positiveId} from '../domain.js';
import {calendarDate} from '../staffDomain.js';
import {StaffModel} from '../models/StaffModel.js';
import {EligibilityModel} from '../models/EligibilityModel.js';
import {StudioService} from '../studios/service.js';
import {StudioStripe} from '../studios/stripe.js';
import {enqueueNotification} from '../notifications/store.js';
import {quote} from './pricing.js';
const objectId=(v:any):string|undefined=>typeof v==='string'?v:v?.id;
export class PassBilling {
 constructor(readonly pool:Pool,readonly stripe?:StudioStripe,readonly zone='America/New_York'){}
 provider(){if(!this.stripe)throw new AppError(503,'PAYMENTS_UNAVAILABLE','Card checkout is not configured.');return this.stripe;}
 async mine(userid:number){const online=(await this.pool.query(`SELECT id,plan_snapshot AS plan,to_char(valid_date,'YYYY-MM-DD') AS "validDate",amount_cents AS "amountCents",status,refund_status AS "refundStatus",
  ((valid_date-3)::timestamp AT TIME ZONE $2) AS "cancelBy" FROM app_pass_checkout WHERE userid=$1 ORDER BY created_at DESC LIMIT 100`,[userid,this.zone])).rows;
  const manual=(await this.pool.query(`SELECT 'manual:'||d.dayid AS id,d.plan_snapshot AS plan,to_char(d.validdate,'YYYY-MM-DD') AS "validDate",round(COALESCE(p.price,0)*100)::int AS "amountCents",d.status,CASE WHEN p.paymentstatus='refunded' THEN 'succeeded' ELSE NULL END AS "refundStatus",
   ((d.validdate::date-3)::timestamp AT TIME ZONE $2) AS "cancelBy" FROM day_pass d LEFT JOIN payment p ON p.paymentid=d.paymentid
   WHERE d.userid=$1 AND NOT EXISTS(SELECT 1 FROM app_pass_checkout c WHERE c.pass_id=d.dayid) ORDER BY d.dayid DESC LIMIT 100`,[userid,this.zone])).rows;
  return [...online,...manual];}
 async cancelManual(userid:number,id:number){
  return transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   const r=(await db.query(`SELECT d.*,p.paymentstatus,p.price,p.method,now()<=((d.validdate::date-3)::timestamp AT TIME ZONE $3) AS timely
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
 async checkout(userid:number,body:any){
  const date=calendarDate(body.validDate),id=positiveId(body.planId);
  const row=await transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   const user=await new StudioService(this.pool).actor(db,userid),model=new StaffModel(db);
   if((await new EligibilityModel(db,this.zone).waivers(userid)).some(w=>!w.signed))throw new AppError(403,'WAIVER_REQUIRED','Sign the required waivers before purchasing access.');
   if(date<new StudioService(this.pool,this.zone).today())throw new AppError(400,'INVALID_DATE','Choose today or a future date.');
   const plan=await model.plan(id,true);
   if(!plan?.active||plan.kind!=='day_pass')throw new AppError(400,'INVALID_PLAN','Choose an active day-pass plan.');
   const offer=await quote(db,userid,plan,date);
   if(body.expectedRevision!==plan.revision||body.pricingRevision!==offer.pricingRevision||body.amountCents!==offer.amountCents)throw new AppError(409,'PRICE_CHANGED','Refresh and review the current price.');
   const old=(await db.query("SELECT * FROM app_pass_checkout WHERE userid=$1 AND valid_date=$2 AND status NOT IN ('expired','cancelled') FOR UPDATE",[userid,date])).rows[0];
   if(old){if(old.tierid!==id||old.amount_cents!==offer.amountCents)throw new AppError(409,'CHECKOUT_EXISTS','Cancel the existing checkout before changing plans.');return {...old,email:user.email};}
   if(await model.passExists(userid,date))throw new AppError(409,'PASS_EXISTS','You already have a pass for this date.');
   if(offer.amountCents>0)this.provider();
   const r=(await db.query(`INSERT INTO app_pass_checkout(id,userid,tierid,valid_date,plan_snapshot,amount_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),userid,id,date,JSON.stringify({...plan,price:(offer.amountCents/100).toFixed(2),priceBasis:offer.basis}),offer.amountCents])).rows[0];
   if(r.amount_cents===0)await this.issue(db,r,'free:'+r.id);
   return {...r,email:user.email};
  });
  if(row.amount_cents===0)return {issued:true};
  if(row.status!=='pending')throw new AppError(409,'PASS_EXISTS','This pass is already issued or cancelled. Refresh its status.');
  if(!row.checkout_id&&Date.now()-new Date(row.created_at).getTime()>23*3600000)throw new AppError(409,'RECONCILE_REQUIRED','Staff must reconcile this checkout.');
  const p=this.provider(),s=row.checkout_id?await p.sdk.checkout.sessions.retrieve(row.checkout_id):await p.sdk.checkout.sessions.create({mode:'payment',client_reference_id:row.id,customer_email:row.email,
   metadata:{dayPassCheckoutId:row.id},success_url:p.config.origin+'/membership?pass=returned',cancel_url:p.config.origin+'/membership?pass=cancelled',
   payment_intent_data:{metadata:{dayPassCheckoutId:row.id}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:row.amount_cents,product_data:{name:row.plan_snapshot.name}}}]},{idempotencyKey:'daypass-checkout:'+row.id});
  if(s.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test payments only.');
  await this.pool.query('UPDATE app_pass_checkout SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL',[row.id,s.id]);
  if(s.status==='expired'){await this.pool.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending'",[row.id]);throw new AppError(409,'CHECKOUT_EXPIRED','Checkout expired. Refresh and try again.');}
  if(s.status!=='open'||!s.url)throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh shortly.');
  return {checkoutUrl:s.url};
 }
 async issue(db:Database,r:any,reference:string){
  if(r.pass_id)return;
  const model=new StaffModel(db),date=new Date(r.valid_date).toISOString().slice(0,10);
  if(await model.passExists(r.userid,date))throw new AppError(409,'PASS_EXISTS','An existing pass requires payment reconciliation.');
  const pass=await model.createPass(r.userid,r.plan_snapshot,date,r.userid,'Online day pass');
  const payment=await model.createPayment(r.userid,null,(r.amount_cents/100).toFixed(2),r.amount_cents?'paid':'waived',r.amount_cents?'card':'none',reference,'Online day pass',r.userid);
  await model.linkPassPayment(pass,payment);
  await db.query("UPDATE app_pass_checkout SET pass_id=$2,payment_id=$3,status='paid' WHERE id=$1",[r.id,pass,payment]);
  await model.audit(r.userid,r.userid,'daypass.issued','day_pass',pass,'Online day pass',null,{payment,reference});
  await enqueueNotification(db,{userId:r.userid,kind:'payment_receipt',dedupeKey:'daypass-receipt:'+r.id,payload:{amount:(r.amount_cents/100).toFixed(2),currency:'USD',reference,method:r.amount_cents?'Card (test mode)':'Approved free access',paymentId:payment,membershipName:r.plan_snapshot.name,validDate:date}});
 }
 async freeMembership(userid:number,body:any){
  return transaction(this.pool,async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
   await new StudioService(this.pool).actor(db,userid);
   if((await new EligibilityModel(db,this.zone).waivers(userid)).some(w=>!w.signed))throw new AppError(403,'WAIVER_REQUIRED','Sign required waivers first.');
   const model=new StaffModel(db),plan=await model.plan(positiveId(body.planId),true);
   if(!plan?.active||plan.kind!=='membership'||plan.months!==1)throw new AppError(400,'INVALID_PLAN','Choose an active monthly plan.');
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
   const r=(await db.query('SELECT *,now()<=((valid_date-3)::timestamp AT TIME ZONE $3) AS timely FROM app_pass_checkout WHERE id::text=$1 AND userid=$2 FOR UPDATE',[id,userid,this.zone])).rows[0];
   if(!r)throw new AppError(404,'NOT_FOUND','Day-pass checkout not found.');
   if(r.status==='cancelled'||r.status==='expired')return r;
   if(r.status==='paid'&&!r.cancel_requested_at&&!r.timely)throw new AppError(409,'CANCELLATION_NOTICE','Day passes require at least 3 days cancellation notice.');
   await db.query("UPDATE app_pass_checkout SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1 AND status='paid'",[id]);return r;
  });
  if(['cancelled','expired'].includes(row.status))return {cancelled:true};
  if(row.status==='pending'){
   const sdk=this.provider().sdk;
   if(!row.checkout_id)throw new AppError(409,'RECONCILE_REQUIRED','Resume checkout before cancelling.');
   let s=await sdk.checkout.sessions.retrieve(row.checkout_id);
   if(s.status==='open')s=await sdk.checkout.sessions.expire(s.id);
   if(s.status!=='expired')throw new AppError(409,'PAYMENT_PROCESSING','Payment completed. Refresh after verification before cancelling.');
   await this.pool.query("UPDATE app_pass_checkout SET status='expired',cancel_requested_at=NULL WHERE id=$1 AND status='pending'",[id]);return {cancelled:true};
  }
  return transaction(this.pool,async db=>{
   const r=(await db.query('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0];
   if(r.status==='cancelled')return {cancelled:true};
   if(r.amount_cents===0){await this.finishCancel(db,r);return {cancelled:true};}
   if(!r.payment_intent)throw new AppError(409,'RECONCILE_REQUIRED','Original card payment must be reconciled.');
   const sdk=this.provider().sdk,existing=await sdk.refunds.list({payment_intent:r.payment_intent,limit:100});
   if(existing.has_more||existing.data.length>1||existing.data.some(f=>f.amount!==r.amount_cents||f.currency!=='usd'))throw new AppError(409,'RECONCILE_REQUIRED','Existing refunds require staff reconciliation.');
   const f=existing.data[0]??await sdk.refunds.create({payment_intent:r.payment_intent,amount:r.amount_cents},{idempotencyKey:'daypass-refund:'+id});
   await this.applyRefund(db,f);return {cancelled:f.status==='succeeded',refundStatus:f.status};
  });
 }
 async finishCancel(db:Database,r:any){
  await db.query("UPDATE app_pass_checkout SET status='cancelled' WHERE id=$1",[r.id]);
  await db.query("UPDATE day_pass SET status='cancelled',statusdesc='Member cancellation with 3 days notice',revision=revision+1 WHERE dayid=$1",[r.pass_id]);
 }
 async applyRefund(db:Database,f:Stripe.Refund){
  const r=(await db.query('SELECT * FROM app_pass_checkout WHERE payment_intent=$1 FOR UPDATE',[objectId(f.payment_intent)])).rows[0];
  if(!r||r.refund_status==='succeeded')return;
  if(f.amount!==r.amount_cents||f.currency!=='usd')throw new AppError(409,'RECONCILE_REQUIRED','Refund amount mismatch.');
  await db.query('UPDATE app_pass_checkout SET refund_id=$2,refund_status=$3 WHERE id=$1',[r.id,f.id,f.status]);
  if(f.status==='succeeded'){
   await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1",[r.payment_id]);
   await this.finishCancel(db,r);
   await new StaffModel(db).audit(r.userid,r.userid,'daypass.refunded','payment',r.payment_id,'Original-card refund confirmed',null,{refundId:f.id,amount:f.amount});
   await enqueueNotification(db,{userId:r.userid,kind:'payment_refunded',dedupeKey:'daypass-refund:'+r.id,payload:{reference:f.id,amount:(f.amount/100).toFixed(2),currency:'USD',method:'Original card (test mode)'}});
  }
 }
 async webhook(event:Stripe.Event){
  if(event.livemode)throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test events only.');
  const sdk=this.provider().sdk,obj=event.data.object as any;
  await transaction(this.pool,async db=>{
   if(!(await db.query('INSERT INTO app_pass_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[event.id])).rowCount)return;
   if(['refund.created','refund.updated','refund.failed'].includes(event.type)){await this.applyRefund(db,await sdk.refunds.retrieve(obj.id));return;}
   if(!event.type.startsWith('checkout.session.'))return;
   // Ignore other products' Checkout events without an unnecessary provider call.
   const known=(await db.query('SELECT id FROM app_pass_checkout WHERE checkout_id=$1 OR id::text=$2',[obj.id,obj.metadata?.dayPassCheckoutId??''])).rows[0];
   if(!known)return;
   const s=await sdk.checkout.sessions.retrieve(obj.id),id=s.metadata?.dayPassCheckoutId;
   if(!id)return;
   const owner=(await db.query('SELECT userid FROM app_pass_checkout WHERE id::text=$1',[id])).rows[0];if(!owner)return;
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,owner.userid]);
   const r=(await db.query('SELECT * FROM app_pass_checkout WHERE id::text=$1 FOR UPDATE',[id])).rows[0];
   if(s.livemode||s.mode!=='payment'||s.client_reference_id!==r.id||r.checkout_id&&s.id!==r.checkout_id||s.amount_total!==r.amount_cents||s.currency!=='usd')throw new AppError(400,'PAYMENT_MISMATCH','Day-pass payment does not match checkout.');
   if(s.status==='expired'){await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending'",[id]);return;}
   if(event.type==='checkout.session.async_payment_failed'&&s.payment_status==='unpaid'){
    await db.query("UPDATE app_pass_checkout SET status='expired' WHERE id=$1 AND status='pending'",[id]);return;
   }
   if(s.status!=='complete'||s.payment_status!=='paid')return;
   const pi=objectId(s.payment_intent);if(!pi)throw new AppError(400,'PAYMENT_MISMATCH','Original payment missing.');
   await db.query('UPDATE app_pass_checkout SET checkout_id=$2,payment_intent=$3 WHERE id=$1',[id,s.id,pi]);
   await this.issue(db,r,s.id);
   // Refund delivery can precede checkout delivery. Reconcile the original
   // payment so a late checkout cannot grant access to an already-refunded pass.
   const refunds=await sdk.refunds.list({payment_intent:pi,limit:100});
   if(refunds.has_more||refunds.data.length>1||refunds.data.some(f=>f.amount!==r.amount_cents||f.currency!=='usd'))
    throw new AppError(409,'RECONCILE_REQUIRED','Existing refunds require staff reconciliation.');
   if(refunds.data[0])await this.applyRefund(db,refunds.data[0]);
  });
 }
}
