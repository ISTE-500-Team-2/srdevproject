import type {Pool} from 'pg';
import {transaction,type Database} from '../db.js';
import {AppError,positiveId,textField} from '../domain.js';
import {calendarDate} from '../staffDomain.js';
import {StaffModel,type Plan} from '../models/StaffModel.js';
import {StudioService} from '../studios/service.js';
export async function quote(db:Database,userid:number,plan:Plan,through:string) {
 const policy=(await db.query('SELECT * FROM app_billing_price WHERE tierid=$1 FOR SHARE',[plan.id])).rows[0];
 const user=(await db.query('SELECT is_student FROM "user" WHERE userid=$1 FOR SHARE',[userid])).rows[0];
 const partner=(await db.query('SELECT userid FROM app_partner_eligibility WHERE userid=$1 AND valid_until>=$2::date FOR SHARE',[userid,through])).rowCount;
 const base=Math.round(Number(plan.price)*100);
 let amount=base,basis='standard';
 if(user?.is_student&&policy?.student_cents!=null&&policy.student_cents<amount){amount=policy.student_cents;basis='student';}
 if(partner&&policy?.partner_free){amount=0;basis='school_partner';}
 if(!Number.isSafeInteger(amount)||amount<0||amount>10000000||amount>0&&amount<50) throw new AppError(400,'INVALID_PRICE','Staff must configure a supported rate.');
 return {amountCents:amount,basis,pricingRevision:policy?.revision??0};
}
export class BillingPricing {
 constructor(readonly pool:Pool){}
 async offers(userid:number,date?:string) {
  const through=(await this.pool.query("SELECT to_char(now()+interval '1 month','YYYY-MM-DD') AS date")).rows[0].date;
  return transaction(this.pool,async db=>{
   await new StudioService(this.pool).actor(db,userid);
   const plans=await new StaffModel(db).plans(true);
   return Promise.all(plans.filter(p=>p.kind==='day_pass'||p.months===1).map(async p=>({...p,...await quote(db,userid,p,p.kind==='day_pass'&&date?calendarDate(date):through)})));
  });
 }
 async configure(actor:number,id:number,body:any) {
  const reason=textField(body.reason,'Reason',255,3),student=body.studentCents;
  if(student!==null&&(!Number.isSafeInteger(student)||student<0||student>10000000||student>0&&student<50)||typeof body.partnerFree!=='boolean') throw new AppError(400,'INVALID_PRICE','Provide a valid student price or null and a free-access setting.');
  return transaction(this.pool,async db=>{
   await new StudioService(this.pool).actor(db,actor,true,true);
   const plan=await new StaffModel(db).plan(id,true);
   if(!plan)throw new AppError(404,'NOT_FOUND','Plan not found.');
   if(student!==null&&student>Math.round(Number(plan.price)*100))throw new AppError(400,'INVALID_PRICE','A student rate cannot exceed the standard price.');
   await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7135,id]);
   const old=(await db.query('SELECT * FROM app_billing_price WHERE tierid=$1',[id])).rows[0];
   if(body.revision!==(old?.revision??0))throw new AppError(409,'PRICE_CHANGED','Refresh pricing before saving.');
   const result=(await db.query(`INSERT INTO app_billing_price(tierid,student_cents,partner_free) VALUES($1,$2,$3)
    ON CONFLICT(tierid) DO UPDATE SET student_cents=$2,partner_free=$3,revision=app_billing_price.revision+1 RETURNING *`,[id,student,body.partnerFree])).rows[0];
   await new StaffModel(db).audit(actor,null,'billing.pricing.updated','plan',id,reason,old,result);return result;
  });
 }
 async verifyPartner(actor:number,userid:number,body:any) {
  const reference=textField(body.reference,'Approved school/verification reference',255,3),until=calendarDate(body.validUntil);
  return transaction(this.pool,async db=>{
   await new StudioService(this.pool).actor(db,actor,true);
   if(!await new StaffModel(db).person(positiveId(userid),true))throw new AppError(404,'NOT_FOUND','Member not found.');
   await db.query(`INSERT INTO app_partner_eligibility(userid,reference,valid_until,verified_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(userid) DO UPDATE SET reference=$2,valid_until=$3,verified_by=$4,verified_at=now()`,[userid,reference,until,actor]);
   await new StaffModel(db).audit(actor,userid,'billing.partner.verified','user',userid,reference,null,{validUntil:until});
   return {validUntil:until};
  });
 }
}
