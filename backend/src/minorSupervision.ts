import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { transaction, type Database } from './db.js';
import { AppError, dateOfBirthField, emailField, integerId, positiveId, textField } from './domain.js';
import { authRateLimit, authState, requireCsrf, requireStaff } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { StaffModel } from './models/StaffModel.js';
import { EligibilityModel } from './models/EligibilityModel.js';

/** Active account aged 18+; `$${zone}` is the time-zone parameter. */
const adultSql=(zone:number)=>`dob IS NOT NULL AND dob::date<=((now() AT TIME ZONE $${zone})::date-INTERVAL '18 years')::date
  AND status='active' AND accessstatus='active'`;

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
    const visit=(await this.db.query(`SELECT v.id,v.building_id AS "buildingId",b.name AS "buildingName",v.checked_in_at AS "checkedInAt",
      v.sponsor_id AS "sponsorId" FROM app_facility_visit v JOIN building b ON b.buildingid=v.building_id
      WHERE v.user_id=$1 AND v.checked_out_at IS NULL
      AND (v.checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date`,[id,this.zone])).rows[0] ?? null;
    const pendingRequests=(await this.db.query(`SELECT r.id::int AS id,u.firstname||' '||u.lastname AS "adultName",r.created_at AS "createdAt"
      FROM app_minor_sponsor_request r JOIN "user" u ON u.userid=r.adult_id
      WHERE r.minor_id=$1 AND r.status='pending' ORDER BY r.created_at,r.id`,[id])).rows;
    return {isMinor:minor,marker:minor?'Under 18':null,sponsor,visit,pendingRequests};
  }
  async isAdult(id:number) {
    return !!(await this.db.query(`SELECT 1 FROM "user" WHERE userid=$1 AND ${adultSql(2)}`,[id,this.zone])).rowCount;
  }
  /** Minors an adult sponsors (with today's open visit) and the adult's pending outgoing requests. */
  async minors(adultId:number) {
    const minors=(await this.db.query(`SELECT s.minor_id AS id,u.firstname||' '||u.lastname AS name,
      b.name AS "buildingName",v.checked_in_at AS "checkedInAt"
      FROM app_minor_sponsor s JOIN "user" u ON u.userid=s.minor_id
      LEFT JOIN app_facility_visit v ON v.user_id=s.minor_id AND v.checked_out_at IS NULL
        AND (v.checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
      LEFT JOIN building b ON b.buildingid=v.building_id
      WHERE s.adult_id=$1 ORDER BY u.firstname,u.lastname,s.minor_id`,[adultId,this.zone])).rows
      .map(({buildingName,checkedInAt,...m})=>({...m,visit:checkedInAt?{buildingName,checkedInAt}:null}));
    const requests=(await this.db.query(`SELECT r.id::int AS id,u.firstname AS "minorName",r.created_at AS "createdAt"
      FROM app_minor_sponsor_request r JOIN "user" u ON u.userid=r.minor_id
      WHERE r.adult_id=$1 AND r.status='pending' ORDER BY r.created_at,r.id`,[adultId])).rows;
    return {minors,requests};
  }
}

export function minorSupervisionRoutes(pool:Pool,zone:string) {
  const r=Router();
  r.get('/me/supervision',async(_req,res)=>res.json({data:await new MinorSupervision(pool,zone).summary(authState(res).user.id)}));
  r.post('/me/visit/check-out',requireCsrf,async(_req,res)=>res.json({data:await transaction(pool,db=>new MinorSupervision(db,zone).checkout(authState(res).user.id))}));
  // Adult-initiated, minor-confirmed links. Lock order matches the staff route:
  // minor user row, adult user row, sponsor row, then the minor's open visit.
  const lockUser=(db:Database,id:number)=>db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[id]);
  const openVisit=async(db:Database,id:number)=>!!(await db.query('SELECT id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id])).rowCount;
  // Bounds date-of-birth guessing against a known email. The per-address limiter matches sign-in;
  // the per-adult and per-email budgets live in the database so they survive restarts and races.
  const limitMessage='Too many sponsor requests. Please try again tomorrow or ask staff to link the account.';
  const requestLimit=authRateLimit({limit:20,message:'Too many sponsor requests. Please wait 15 minutes and try again.'});
  const reserveAttempt=(adultId:number,emailHash:string)=>transaction(pool,async db=>{
    // Serialize per adult and per target so concurrent requests cannot both pass the check.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-sponsor-attempt-adult'),$1)",[adultId]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-sponsor-attempt-email'),hashtext($1))",[emailHash]);
    const counts=(await db.query(`SELECT
        count(*) FILTER (WHERE adult_id=$1 AND created_at>now()-interval '1 day')::int AS adult,
        count(*) FILTER (WHERE adult_id=$1 AND email_hash=$2 AND NOT matched AND created_at>now()-interval '1 day')::int AS pair,
        count(*) FILTER (WHERE email_hash=$2 AND NOT matched)::int AS email
      FROM app_minor_sponsor_attempt WHERE created_at>now()-interval '30 days' AND (adult_id=$1 OR email_hash=$2)`,[adultId,emailHash])).rows[0];
    // Per day: 10 attempts per adult, 5 misses per adult+email. Per target email: 15 misses in
    // 30 days across all adults, so the guess budget does not grow with extra accounts or time;
    // a locked-out parent can still be linked by staff at the front desk.
    if (counts.adult>=10 || counts.pair>=5 || counts.email>=15) throw new AppError(429,'RATE_LIMITED',limitMessage);
    return (await db.query('INSERT INTO app_minor_sponsor_attempt(adult_id,email_hash) VALUES($1,$2) RETURNING id',[adultId,emailHash])).rows[0].id as string;
  });
  r.get('/me/minors',async(_req,res)=>res.json({data:await new MinorSupervision(pool,zone).minors(authState(res).user.id)}));
  r.post('/me/minors/requests',requireCsrf,requestLimit,async(req,res)=>{
    const me=authState(res).user.id,email=emailField(req.body.email),dob=dateOfBirthField(req.body.dob);
    if (!await new MinorSupervision(pool,zone).isAdult(me)) throw new AppError(403,'ADULT_REQUIRED','Only active accounts aged 18 or older can sponsor a minor.');
    const attempt=await reserveAttempt(me,createHash('sha256').update(email.toLowerCase()).digest('hex'));
    const data=await transaction(pool,async db=>{
      const service=new MinorSupervision(db,zone),adultRequired=()=>new AppError(403,'ADULT_REQUIRED','Only active accounts aged 18 or older can sponsor a minor.');
      if (!await service.isAdult(me)) throw adultRequired();
      // One answer for every mismatch so the form cannot reveal which accounts exist.
      const minor=(await db.query(`SELECT userid AS id,firstname AS name FROM "user"
        WHERE lower(email)=$1 AND dob IS NOT NULL AND dob::date=$2::date AND status='active' AND accessstatus='active'
        AND dob::date>((now() AT TIME ZONE $3)::date-INTERVAL '18 years')::date FOR UPDATE`,[email,dob,zone])).rows[0];
      if (!minor) throw new AppError(404,'NOT_FOUND','No under-18 account matches that email and date of birth.');
      // Outside this transaction so a later 409 still records that the details matched.
      await pool.query('UPDATE app_minor_sponsor_attempt SET matched=true WHERE id=$1',[attempt]);
      if (!(await db.query(`SELECT userid FROM "user" WHERE userid=$1 AND ${adultSql(2)} FOR SHARE`,[me,zone])).rowCount) throw adultRequired();
      if ((await db.query('SELECT 1 FROM app_minor_sponsor WHERE minor_id=$1 AND adult_id=$2',[minor.id,me])).rowCount)
        throw new AppError(409,'ALREADY_LINKED','You already sponsor this account.');
      // Self-service only fills an empty sponsor slot; replacing a sponsor stays a staff decision.
      if ((await db.query('SELECT 1 FROM app_minor_sponsor WHERE minor_id=$1',[minor.id])).rowCount)
        throw new AppError(409,'SPONSOR_EXISTS','This account already has a sponsoring adult. Staff at the front desk can change it.');
      if ((await db.query("SELECT 1 FROM app_minor_sponsor_request WHERE minor_id=$1 AND adult_id=$2 AND status='pending'",[minor.id,me])).rowCount)
        throw new AppError(409,'REQUEST_PENDING','You already have a pending request for this account.');
      const row=(await db.query(`INSERT INTO app_minor_sponsor_request(minor_id,adult_id) VALUES($1,$2)
        RETURNING id::int AS id,created_at AS "createdAt"`,[minor.id,me])).rows[0];
      return {id:row.id,minorName:minor.name,createdAt:row.createdAt};
    });res.status(201).json({data});
  });
  r.post('/me/minors/requests/:id/cancel',requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,id=positiveId(req.params.id);
    const data=await transaction(pool,async db=>{
      const found=(await db.query("SELECT minor_id FROM app_minor_sponsor_request WHERE id=$1 AND adult_id=$2 AND status='pending'",[id,me])).rows[0];
      if (found) await lockUser(db,found.minor_id);
      if (!found || !(await db.query(`UPDATE app_minor_sponsor_request SET status='cancelled',resolved_at=now()
        WHERE id=$1 AND status='pending'`,[id])).rowCount) throw new AppError(404,'NOT_FOUND','No pending request found.');
      return new MinorSupervision(db,zone).minors(me);
    });res.json({data});
  });
  r.post('/me/minors/:minorId/unlink',requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,minor=integerId(req.params.minorId,'Minor');
    const data=await transaction(pool,async db=>{
      await lockUser(db,minor);
      const existing=(await db.query('SELECT * FROM app_minor_sponsor WHERE minor_id=$1 AND adult_id=$2 FOR UPDATE',[minor,me])).rows[0];
      if (!existing) throw new AppError(404,'NOT_FOUND','You do not sponsor this account.');
      if (await openVisit(db,minor)) throw new AppError(409,'CHECK_OUT_FIRST','Check out the minor before removing your sponsorship.');
      await db.query('DELETE FROM app_minor_sponsor WHERE minor_id=$1',[minor]);
      await new StaffModel(db,zone).audit(me,minor,'minor.sponsor_unlinked','user',minor,'Sponsoring adult removed their link',existing,null);
      return new MinorSupervision(db,zone).minors(me);
    });res.json({data});
  });
  for (const action of ['accept','decline'] as const) r.post(`/me/sponsor-requests/:id/${action}`,requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,id=positiveId(req.params.id);
    const data=await transaction(pool,async db=>{
      const service=new MinorSupervision(db,zone);
      await lockUser(db,me);
      const request=(await db.query(`SELECT adult_id FROM app_minor_sponsor_request WHERE id=$1 AND minor_id=$2 AND status='pending' FOR UPDATE`,[id,me])).rows[0];
      if (!request) throw new AppError(404,'NOT_FOUND','No pending sponsor request found.');
      if (action==='decline') {
        await db.query("UPDATE app_minor_sponsor_request SET status='declined',resolved_at=now() WHERE id=$1",[id]);
        return service.summary(me);
      }
      // Re-validate everything the staff link route checks; the request may be stale.
      if (!await service.isMinor(me)) throw new AppError(409,'MINOR_REQUIRED','Only accounts under 18 need a sponsoring adult.');
      if (!(await db.query(`SELECT userid FROM "user" WHERE userid=$1 AND userid<>$3 AND ${adultSql(2)} FOR SHARE`,[request.adult_id,zone,me])).rowCount)
        throw new AppError(409,'ADULT_REQUIRED','This adult can no longer sponsor you. Ask them to check their account.');
      const existing=(await db.query('SELECT * FROM app_minor_sponsor WHERE minor_id=$1 FOR UPDATE',[me])).rows[0];
      if (existing && existing.adult_id!==request.adult_id)
        throw new AppError(409,'SPONSOR_EXISTS','You already have a sponsoring adult. Ask staff at the front desk to change it.');
      if (await openVisit(db,me)) throw new AppError(409,'CHECK_OUT_FIRST','Check out before changing your sponsoring adult.');
      await db.query(`INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2) ON CONFLICT(minor_id)
        DO UPDATE SET adult_id=EXCLUDED.adult_id,revision=app_minor_sponsor.revision+1,updated_at=now()`,[me,request.adult_id]);
      // The accepted request resolves; every other pending request for this minor is withdrawn.
      await db.query(`UPDATE app_minor_sponsor_request SET status=CASE WHEN id=$2 THEN 'accepted' ELSE 'cancelled' END,resolved_at=now()
        WHERE minor_id=$1 AND status='pending'`,[me,id]);
      await new StaffModel(db,zone).audit(me,me,'minor.sponsor_linked','user',me,'Minor accepted sponsor request',existing ?? null,{adultId:request.adult_id,requestId:id});
      return service.summary(me);
    });res.json({data});
  });
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
