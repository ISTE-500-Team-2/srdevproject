import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {transaction, type Database} from '../db.js';
import {AppError, positiveId, textField} from '../domain.js';
import {StudioService} from '../studios/service.js';
import {StudioStripe} from '../studios/stripe.js';
import {StaffModel, type Plan} from '../models/StaffModel.js';
interface BillingRecord {id:string;userid:number;tierid:number;plan_snapshot:Plan;amount_cents:number;checkout_id:string|null;subscription_id:string|null;customer_id:string|null;status:string;created_at:Date;}
import {enqueueNotification} from '../notifications/store.js';

const objectId = (v: string | {id:string} | null | undefined) => typeof v === 'string' ? v : v?.id;
const terminal = new Set(['canceled','incomplete_expired','expired']);
export class MembershipBilling {
  constructor(readonly pool:Pool, readonly stripe?:StudioStripe) {}
  provider() {
    if (!this.stripe) throw new AppError(503,'PAYMENTS_UNAVAILABLE','Test card billing is not configured.');
    return this.stripe;
  }
  async mine(userid:number) {
    return (await this.pool.query(`SELECT id,tierid AS "planId",plan_snapshot AS plan,status,
      cancel_at_period_end AS "cancelAtPeriodEnd",current_period_end AS "currentPeriodEnd",
      amount_cents AS "amountCents" FROM app_membership_billing WHERE userid=$1 ORDER BY created_at DESC LIMIT 100`,[userid])).rows;
  }
  async checkout(userid:number, body:any) {
    const provider=this.provider(), planId=positiveId(body.planId);
    if(body.autoRenewConsent !== true) throw new AppError(400,'CONSENT_REQUIRED','Agree to monthly automatic renewal before continuing.');
    const row=await transaction(this.pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,userid]);
      const user=await new StudioService(this.pool).actor(db,userid);
      const plan=await new StaffModel(db).plan(planId,true);
      if(!plan?.active || plan.kind!=='membership' || plan.months!==1)
        throw new AppError(400,'MONTHLY_PLAN_REQUIRED','Choose an active one-month membership plan.');
      if(plan.revision!==body.expectedRevision) throw new AppError(409,'PRICE_CHANGED','Refresh and review the current monthly price.');
      const amount=Math.round(Number(plan.price)*100);
      if(!Number.isSafeInteger(amount)||amount<50||amount>10000000) throw new AppError(400,'INVALID_PRICE','Staff must configure a supported monthly rate.');
      const old=(await db.query("SELECT * FROM app_membership_billing WHERE userid=$1 AND status NOT IN ('canceled','incomplete_expired','expired') FOR UPDATE",[userid])).rows[0];
      if(old) {
        if(old.status!=='pending'||old.tierid!==planId||old.amount_cents!==amount)
          throw new AppError(409,'BILLING_EXISTS','An active membership or checkout already exists. Manage it before starting another.');
        return {...old,email:user.email};
      }
      const existing=await db.query("SELECT membershipid FROM user_membership WHERE userid=$1 AND status IN ('active','suspended') AND end_date>NOW() AT TIME ZONE 'UTC'",[userid]);
      if(existing.rowCount) throw new AppError(409,'MEMBERSHIP_EXISTS','Contact staff before replacing an existing membership. No automatic billing was started.');
      const r=(await db.query(`INSERT INTO app_membership_billing(id,userid,tierid,plan_snapshot,amount_cents)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[randomUUID(),userid,planId,JSON.stringify(plan),amount])).rows[0];
      return {...r,email:user.email};
    });
    // Stable server-owned ID makes retries safe; an unresolved checkout is never
    // silently replaced after Stripe's idempotency retention window.
    if(!row.checkout_id && Date.now()-new Date(row.created_at).getTime()>23*3600000)
      throw new AppError(409,'RECONCILE_REQUIRED','Staff must reconcile this old checkout before trying again.');
    const session=row.checkout_id ? await provider.sdk.checkout.sessions.retrieve(row.checkout_id) :
      await provider.sdk.checkout.sessions.create({
        mode:'subscription', integration_identifier:'arbor-memberships-vqkntpaz',
        client_reference_id:row.id,customer_email:row.email,
        metadata:{membershipBillingId:row.id},subscription_data:{metadata:{membershipBillingId:row.id}},
        success_url:provider.config.origin+'/membership?billing=returned',
        cancel_url:provider.config.origin+'/membership?billing=cancelled',
        line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:row.amount_cents,
          recurring:{interval:'month'},product_data:{name:row.plan_snapshot.name}}}],
      },{idempotencyKey:'membership-checkout:'+row.id});
    if(session.livemode) throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test payments only.');
    await this.pool.query('UPDATE app_membership_billing SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL',[row.id,session.id]);
    if(session.status==='expired') {
      await this.pool.query("UPDATE app_membership_billing SET status='expired' WHERE id=$1 AND status='pending'",[row.id]);
      throw new AppError(409,'CHECKOUT_EXPIRED','Checkout expired. Start again after refreshing.');
    }
    if(session.status!=='open'||!session.url) throw new AppError(409,'PAYMENT_PROCESSING','Payment is being verified. Refresh your membership status shortly.');
    return {checkoutUrl:session.url};
  }
  async cancel(userid:number,id:string) {
    const provider=this.provider();
    const row=(await this.pool.query('SELECT * FROM app_membership_billing WHERE id::text=$1 AND userid=$2',[id,userid])).rows[0];
    if(!row) throw new AppError(404,'NOT_FOUND','Membership billing record not found.');
    if(terminal.has(row.status)) return;
    if(row.subscription_id) {
      await transaction(this.pool,async db=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtext('membership-stripe'),hashtext($1))",[row.subscription_id]);
        const sub=await provider.sdk.subscriptions.update(row.subscription_id,{cancel_at_period_end:true});
        await this.syncSubscription(db,sub);
      });
    } else if(row.checkout_id) {
      let s=await provider.sdk.checkout.sessions.retrieve(row.checkout_id);
      if(s.status==='open') s=await provider.sdk.checkout.sessions.expire(s.id);
      if(s.status!=='expired') throw new AppError(409,'PAYMENT_PROCESSING','Checkout completed. Wait for verification, then turn off renewal.');
      await this.pool.query("UPDATE app_membership_billing SET status='expired' WHERE id=$1 AND status='pending'",[row.id]);
    } else throw new AppError(409,'RECONCILE_REQUIRED','Resume checkout once before cancelling.');
  }
  async portal(userid:number,id:string) {
    const p=this.provider();
    const r=(await this.pool.query('SELECT customer_id FROM app_membership_billing WHERE id::text=$1 AND userid=$2',[id,userid])).rows[0];
    if(!r?.customer_id) throw new AppError(404,'NOT_FOUND','A verified billing account is required.');
    const s=await p.sdk.billingPortal.sessions.create({customer:r.customer_id,return_url:p.config.origin+'/membership'});
    return {url:s.url};
  }
  async syncSubscription(db:Database, sub:Stripe.Subscription) {
    if(sub.livemode) throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test events only.');
    // First-class subscription ID is primary; metadata is only the initial
    // Checkout-to-subscription binding for a server-created pending row.
    let r=(await db.query<BillingRecord>('SELECT * FROM app_membership_billing WHERE subscription_id=$1 FOR UPDATE',[sub.id])).rows[0];
    if(!r && sub.metadata.membershipBillingId) r=(await db.query<BillingRecord>("SELECT * FROM app_membership_billing WHERE id::text=$1 AND subscription_id IS NULL AND status='pending' FOR UPDATE",[sub.metadata.membershipBillingId])).rows[0];
    if(!r) return undefined;
    const item=sub.items.data[0];
    if(sub.items.data.length!==1||!item||item.quantity!==1||item.price.currency!=='usd'||
      item.price.unit_amount!==r.amount_cents||item.price.recurring?.interval!=='month'||item.price.recurring.interval_count!==1)
      throw new AppError(400,'PAYMENT_MISMATCH','Subscription does not match the accepted monthly plan.');
    const customer=objectId(sub.customer);
    if(!customer||r.customer_id&&r.customer_id!==customer) throw new AppError(400,'PAYMENT_MISMATCH','Billing customer mismatch.');
    await db.query(`UPDATE app_membership_billing SET subscription_id=$2,customer_id=$3,status=$4,
      cancel_at_period_end=$5,current_period_end=to_timestamp($6) WHERE id=$1`,
      [r.id,sub.id,customer,sub.status,sub.cancel_at_period_end,item.current_period_end]);
    // Subscription status alone NEVER grants access. Only invoice.paid creates
    // an immutable paid period; a failed renewal cannot extend the previous one.
    return {...r,subscription_id:sub.id,customer_id:customer};
  }
  async invoicePaid(db:Database, invoice:Stripe.Invoice, row:any) {
    if(invoice.livemode||invoice.status!=='paid'||invoice.currency!=='usd'||
       objectId(invoice.customer)!==row.customer_id||objectId(invoice.parent?.subscription_details?.subscription)!==row.subscription_id||invoice.amount_paid!==row.amount_cents||
       !['subscription_create','subscription_cycle'].includes(invoice.billing_reason??''))
      throw new AppError(400,'PAYMENT_MISMATCH','Invoice needs reconciliation; no membership was issued.');
    if((await db.query('SELECT id FROM app_membership_invoice WHERE id=$1',[invoice.id])).rowCount) return;
    const lines=invoice.lines.data;
    if(invoice.lines.has_more||lines.length!==1||lines[0]!.amount!==row.amount_cents)
      throw new AppError(400,'PAYMENT_MISMATCH','Unexpected invoice lines.');
    const line=lines[0]!, {start,end}=line.period;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>32*86400)
      throw new AppError(400,'PAYMENT_MISMATCH','Invalid paid membership period.');
    const from=new Date(start*1000),to=new Date(end*1000);
    await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7121,row.userid]);
    const overlap=await db.query(`SELECT membershipid FROM user_membership WHERE userid=$1 AND status IN ('active','suspended')
      AND startdate<$3::timestamptz AT TIME ZONE 'UTC' AND end_date>$2::timestamptz AT TIME ZONE 'UTC'`,[row.userid,from,to]);
    if(overlap.rowCount) throw new AppError(409,'MEMBERSHIP_OVERLAP','Paid membership overlaps an existing period; staff reconciliation required.');
    const model=new StaffModel(db);
    const membership=await model.createMembership(row.userid,row.plan_snapshot,from.toISOString(),to,row.userid,'Stripe test invoice '+invoice.id);
    const payment=await model.createPayment(row.userid,membership,(row.amount_cents/100).toFixed(2),'paid','card',invoice.id,'Stripe test recurring membership',row.userid);
    await db.query('INSERT INTO app_membership_invoice(id,billing_id,membership_id,payment_id,period_start,period_end) VALUES($1,$2,$3,$4,$5,$6)',[invoice.id,row.id,membership,payment,from,to]);
    await enqueueNotification(db,{userId:row.userid,kind:'payment_receipt',dedupeKey:'membership-receipt:'+invoice.id,
      payload:{amount:(row.amount_cents/100).toFixed(2),currency:'USD',reference:invoice.id,paymentId:payment,method:'Card (test mode)',membershipName:row.plan_snapshot.name,startsAt:from.toISOString(),endsAt:to.toISOString()}});
  }
  async invoices(actor:number) {
    await new StudioService(this.pool).actor(this.pool,actor,true);
    return (await this.pool.query(`SELECT i.id,b.userid AS "userId",b.plan_snapshot->>'name' AS "planName",
      b.amount_cents AS "amountCents",i.period_start AS "periodStart",i.period_end AS "periodEnd",
      i.refund_status AS "refundStatus" FROM app_membership_invoice i JOIN app_membership_billing b ON b.id=i.billing_id
      ORDER BY i.period_start DESC LIMIT 200`)).rows;
  }
  async refund(actor:number,id:string,reason:unknown) {
    const explanation=textField(reason,'Refund reason',255,3),sdk=this.provider().sdk;
    return transaction(this.pool,async db=>{
      await new StudioService(this.pool).actor(db,actor,true);
      const r=(await db.query(`SELECT i.*,b.userid,b.amount_cents FROM app_membership_invoice i
        JOIN app_membership_billing b ON b.id=i.billing_id WHERE i.id=$1 FOR UPDATE OF i`,[id])).rows[0];
      if(!r) throw new AppError(404,'NOT_FOUND','Invoice not found.');
      if(r.refund_status==='succeeded') return {status:'succeeded'};
      if(!r.payment_intent) {
        const payments=await sdk.invoicePayments.list({invoice:id,status:'paid',limit:100});
        const p=payments.data[0];
        if(payments.has_more||payments.data.length!==1||!p||p.livemode||p.currency!=='usd'||p.amount_paid!==r.amount_cents||p.payment.type!=='payment_intent')
          throw new AppError(409,'RECONCILE_REQUIRED','Invoice needs original-payment reconciliation in Stripe.');
        r.payment_intent=objectId(p.payment.payment_intent);
        if(!r.payment_intent) throw new AppError(409,'RECONCILE_REQUIRED','Original payment is missing.');
        await db.query('UPDATE app_membership_invoice SET payment_intent=$2 WHERE id=$1',[id,r.payment_intent]);
      }
      const previous=await sdk.refunds.list({payment_intent:r.payment_intent,limit:100});
      if(previous.has_more||previous.data.some(f=>f.currency!=='usd'||f.amount!==r.amount_cents)||previous.data.length>1)
        throw new AppError(409,'RECONCILE_REQUIRED','Existing partial/multiple refunds need staff reconciliation.');
      const refund=previous.data[0]??await sdk.refunds.create({payment_intent:r.payment_intent,amount:r.amount_cents},{idempotencyKey:'membership-refund:'+id});
      await this.applyRefund(db,refund);
      await new StaffModel(db).audit(actor,r.userid,'billing.refund.requested','payment',r.payment_id,explanation,null,{refundId:refund.id,status:refund.status});
      return {status:refund.status};
    });
  }
  async applyRefund(db:Database,f:Stripe.Refund) {
    const r=(await db.query(`SELECT i.*,b.userid,b.amount_cents FROM app_membership_invoice i
      JOIN app_membership_billing b ON b.id=i.billing_id WHERE i.payment_intent=$1 FOR UPDATE OF i`,[objectId(f.payment_intent)])).rows[0];
    if(!r||f.amount!==r.amount_cents||f.currency!=='usd'||r.refund_status==='succeeded') return;
    await db.query('UPDATE app_membership_invoice SET refund_id=$2,refund_status=$3 WHERE id=$1',[r.id,f.id,f.status]);
    if(f.status==='succeeded') {
      await db.query("UPDATE payment SET paymentstatus='refunded',updated_at=now(),revision=revision+1 WHERE paymentid=$1",[r.payment_id]);
      await enqueueNotification(db,{userId:r.userid,kind:'payment_refunded',dedupeKey:'membership-refund:'+r.id,
        payload:{reference:f.id,amount:(f.amount/100).toFixed(2),currency:'USD',method:'Original card (test mode)'}});
    }
    // Refunding a charge does not silently cancel a subscription or revoke a
    // paid period. Those are separate staff/member actions with their own policy.
  }
  async webhook(event:Stripe.Event) {
    if(event.livemode) throw new AppError(400,'LIVE_PAYMENT_FORBIDDEN','Test events only.');
    const sdk=this.provider().sdk;
    await transaction(this.pool,async db=>{
      if(!(await db.query('INSERT INTO app_membership_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[event.id])).rowCount) return;
      if(event.type==='checkout.session.expired') {
        const s=event.data.object as Stripe.Checkout.Session;
        await db.query("UPDATE app_membership_billing SET status='expired' WHERE checkout_id=$1 AND status='pending' AND subscription_id IS NULL",[s.id]);return;
      }
      const obj=event.data.object as any;
      if(['refund.created','refund.updated','refund.failed'].includes(event.type)){await this.applyRefund(db,await sdk.refunds.retrieve(obj.id));return;}
      const sid=event.type.startsWith('customer.subscription.') ? obj.id : event.type.startsWith('invoice.') ? objectId(obj.parent?.subscription_details?.subscription) : event.type.startsWith('checkout.session.') ? objectId(obj.subscription) : undefined;
      if(!sid) return;
      // Retrieve authoritative current state so late/out-of-order events cannot
      // re-enable auto-renew after cancellation.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('membership-stripe'),hashtext($1))",[sid]);
      const sub=await sdk.subscriptions.retrieve(sid);
      const row=await this.syncSubscription(db,sub);
      if(!row) return;
      if(event.type==='invoice.paid') await this.invoicePaid(db,await sdk.invoices.retrieve(obj.id),row);
      if(event.type==='invoice.payment_failed') await enqueueNotification(db,{userId:row.userid,kind:'payment_failed',dedupeKey:'membership-failed:'+obj.id,
        payload:{reference:obj.id,membershipName:row.plan_snapshot.name,instructions:'Update your payment method in Membership & passes. Access is not extended until payment succeeds.'}});
      if(event.type==='invoice.upcoming') await enqueueNotification(db,{userId:row.userid,kind:'membership_renewal',dedupeKey:`membership-renewal:${row.id}:${obj.period_end}`,
        payload:{membershipName:row.plan_snapshot.name,amount:(row.amount_cents/100).toFixed(2),currency:'USD',renewsAt:new Date(obj.period_end*1000).toISOString()}});
    });
  }
}
