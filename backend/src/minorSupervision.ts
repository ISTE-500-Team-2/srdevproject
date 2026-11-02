import { Router } from 'express';
import type { Pool } from 'pg';
import { transaction, type Database } from './db.js';
import { AppError, positiveId, textField } from './domain.js';
import { authState, requireCsrf, requireStaff } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { StaffModel } from './models/StaffModel.js';
import { EligibilityModel } from './models/EligibilityModel.js';

export class MinorSupervision {
  constructor(readonly db: Database, readonly zone = 'America/New_York') {}
  async isMinor(id: number) {
    return (await this.db.query(`SELECT dob IS NOT NULL AND dob::date>((now() AT TIME ZONE $2)::date-INTERVAL '18 years')::date AS minor
      FROM "user" WHERE userid=$1`, [id,this.zone])).rows[0]?.minor === true;
  }
  /** Shared lock serializes booking/access with adult checkout and sponsor reassignment. */
  async requireSponsor(id: number, buildingId?: number) {
    if (!await this.isMinor(id)) return null;
    const sponsor = (await this.db.query(`SELECT s.adult_id AS id,u.firstname||' '||u.lastname AS name,v.id AS visit,
      v.building_id AS building FROM app_minor_sponsor s JOIN "user" u ON u.userid=s.adult_id
      JOIN app_facility_visit v ON v.user_id=s.adult_id AND v.checked_out_at IS NULL
      WHERE s.minor_id=$1 AND u.dob IS NOT NULL
        AND u.dob::date<=((now() AT TIME ZONE $2)::date-INTERVAL '18 years')::date
        AND u.status='active' AND u.accessstatus='active'
        AND (v.checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
        AND ($3::int IS NULL OR v.building_id=$3)
      FOR SHARE OF s,u,v`,[id,this.zone,buildingId ?? null])).rows[0];
    if (!sponsor) throw new AppError(403,'SPONSOR_REQUIRED','Your sponsoring adult must be linked, checked in and remain in this building. Ask staff to check you in together.');
    const eligibility = new EligibilityModel(this.db,this.zone);
    const entitled = await eligibility.entitlement(sponsor.id,new Date());
    const waivers = await eligibility.waivers(sponsor.id);
    if ((!entitled.membership && !entitled.dayPass) || !waivers.length || waivers.some(w=>!w.signed))
      throw new AppError(403,'SPONSOR_INELIGIBLE','Your sponsoring adult needs current access and signed policies.');
    return sponsor;
  }
  async recordBooking(id:number, bookingId:number, studio=false) {
    const sponsor = await this.requireSponsor(id);
    const table = studio ? 'app_minor_studio_booking' : 'app_minor_booking';
    const key = studio ? 'rental_id' : 'reservation_id';
    if (sponsor) await this.db.query(`INSERT INTO ${table}(${key},adult_id) VALUES($1,$2)
      ON CONFLICT(${key}) DO UPDATE SET adult_id=EXCLUDED.adult_id`,[bookingId,sponsor.id]);
    else await this.db.query(`DELETE FROM ${table} WHERE ${key}=$1`,[bookingId]);
  }
  async startVisit(id:number,buildingId:number) {
    const sponsor = await this.requireSponsor(id,buildingId);
    // One open visit, with stale previous-day visits explicitly ended before starting anew.
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext(\'arbor-visit\'),$1)',[id]);
    await this.db.query(`UPDATE app_facility_visit SET checked_out_at=now() WHERE user_id=$1 AND checked_out_at IS NULL
      AND (checked_in_at AT TIME ZONE $2)::date<>(now() AT TIME ZONE $2)::date`,[id,this.zone]);
    const existing=(await this.db.query('SELECT id,building_id,sponsor_id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id])).rows[0];
    if (existing) {
      if (!sponsor && existing.building_id!==buildingId) {
        // An adult's authenticated arrival elsewhere ends their previous visit
        // and checks out supervised minors left in that building.
        await this.checkout(id);
      } else if (existing.building_id!==buildingId || existing.sponsor_id!==(sponsor?.id ?? null))
        throw new AppError(409,'VISIT_EXISTS','Check out the current visit before changing building or sponsor.');
      else return existing;
    }
    return (await this.db.query(`INSERT INTO app_facility_visit(user_id,building_id,sponsor_id) VALUES($1,$2,$3) RETURNING id`,[id,buildingId,sponsor?.id ?? null])).rows[0];
  }
  async checkout(id:number) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-visit'),$1)",[id]);
    // Lock the adult visit first: concurrent minor access/booking holds the same row shared.
    const parent = await this.db.query('SELECT id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id]);
    const result=await this.db.query(`UPDATE app_facility_visit SET checked_out_at=now()
      WHERE checked_out_at IS NULL AND (user_id=$1 OR sponsor_id=$1) RETURNING user_id AS "userId"`,[id]);
    return { checkedOut: result.rows, hadVisit: !!parent.rowCount };
  }
  async summary(id:number) {
    const minor=await this.isMinor(id);
    const sponsor=(await this.db.query(`SELECT s.adult_id AS id,u.firstname||' '||u.lastname AS name,s.revision
      FROM app_minor_sponsor s JOIN "user" u ON u.userid=s.adult_id WHERE s.minor_id=$1`,[id])).rows[0] ?? null;
    const visit=(await this.db.query(`SELECT id,building_id AS "buildingId",checked_in_at AS "checkedInAt",sponsor_id AS "sponsorId"
      FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL
      AND (checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date`,[id,this.zone])).rows[0] ?? null;
    return {isMinor:minor,marker:minor?'Under 18':null,sponsor,visit};
  }
}

export function minorSupervisionRoutes(pool:Pool,zone:string) {
  const r=Router();
  r.get('/me/supervision',async(_req,res)=>res.json({data:await new MinorSupervision(pool,zone).summary(authState(res).user.id)}));
  r.post('/me/visit/check-out',requireCsrf,async(_req,res)=>res.json({data:await transaction(pool,db=>new MinorSupervision(db,zone).checkout(authState(res).user.id))}));
  const base='/admin/users/:id/supervision';
  r.use(base,requireStaff,requirePermission(pool,'user','update','global'));
  r.get(base,async(req,res)=>res.json({data:await new MinorSupervision(pool,zone).summary(positiveId(req.params.id))}));
  const guardTarget = async (db:Database,actorId:number,id:number) => {
    // Match existing staff account-management policy and lock order.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'))");
    const model=new StaffModel(db,zone),target=await model.person(id,true),actor=await model.person(actorId);
    if (!target) throw new AppError(404,'NOT_FOUND','User not found.');
    if (target.roles.some((role:string)=>role==='staff'||role==='admin') && !actor?.roles.includes('admin'))
      throw new AppError(403,'ADMIN_REQUIRED','Only administrators can manage staff accounts.');
  };
  r.post(base,requireCsrf,async(req,res)=>{
    const id=positiveId(req.params.id),adult=positiveId(req.body.adultId),revision=req.body.revision;
    const reason=textField(req.body.reason,'Reason',500);
    if(req.body.consent!==true) throw new AppError(400,'CONSENT_REQUIRED','Verify that the adult agrees to sponsor this minor.');
    const data=await transaction(pool,async db=>{
      await guardTarget(db,authState(res).user.id,id);
      const service=new MinorSupervision(db,zone);
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[id]);
      if (!await service.isMinor(id)) throw new AppError(400,'MINOR_REQUIRED','Choose an account under 18.');
      const eligible=(await db.query(`SELECT userid FROM "user" WHERE userid=$1 AND userid<>$2 AND dob IS NOT NULL
        AND dob::date<=((now() AT TIME ZONE $3)::date-INTERVAL '18 years')::date AND status='active' AND accessstatus='active' FOR SHARE`,[adult,id,zone])).rowCount;
      if (!eligible) throw new AppError(400,'ADULT_REQUIRED','Choose an active adult account aged 18 or older.');
      const existing=(await db.query('SELECT * FROM app_minor_sponsor WHERE minor_id=$1 FOR UPDATE',[id])).rows[0];
      if ((existing?.revision ?? 0)!==revision) throw new AppError(409,'STALE_RECORD','Refresh the sponsor record before saving.');
      if ((await db.query('SELECT id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id])).rowCount)
        throw new AppError(409,'CHECK_OUT_FIRST','Check out the minor before changing their sponsoring adult.');
      await db.query(`INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2) ON CONFLICT(minor_id)
        DO UPDATE SET adult_id=EXCLUDED.adult_id,revision=app_minor_sponsor.revision+1,updated_at=now()`,[id,adult]);
      await new StaffModel(db,zone).audit(authState(res).user.id,id,'minor.sponsor_linked','user',id,reason,existing ?? null,{adultId:adult});
      return service.summary(id);
    });res.json({data});
  });
  for (const action of ['check-in','check-out']) r.post(`${base}/${action}`,requireCsrf,async(req,res)=>{
    const id=positiveId(req.params.id),reason=textField(req.body.reason,'Reason',500);
    const data=await transaction(pool,async db=>{
      await guardTarget(db,authState(res).user.id,id);
      const service=new MinorSupervision(db,zone);
      if (action==='check-in' && !(await db.query('SELECT userid FROM "user" WHERE userid=$1 AND status=\'active\' AND accessstatus=\'active\' FOR SHARE',[id])).rowCount)
        throw new AppError(403,'ACCESS_BLOCKED','This account does not have access.');
      if (action==='check-in') {
        const model=new EligibilityModel(db,zone),entitlement=await model.entitlement(id,new Date()),waivers=await model.waivers(id);
        if (!entitlement.membership && !entitlement.dayPass) throw new AppError(403,'MEMBERSHIP_REQUIRED','Each visitor needs a membership or day pass.');
        if (!waivers.length || waivers.some(w=>!w.signed)) throw new AppError(403,'WAIVER_REQUIRED','Sign current required policies first.');
        const building=positiveId(req.body.buildingId ?? 1);
        if (!(await db.query("SELECT buildingid FROM building WHERE buildingid=$1 AND status='available' FOR SHARE",[building])).rowCount)
          throw new AppError(409,'RESOURCE_UNAVAILABLE','This building is unavailable.');
        await service.startVisit(id,building);
      } else await service.checkout(id);
      await new StaffModel(db,zone).audit(authState(res).user.id,id,`visit.${action}`,'user',id,reason,null,{action});
      return service.summary(id);
    });res.json({data});
  });
  return r;
}
