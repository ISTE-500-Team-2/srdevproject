// Member and staff routes for minor sponsorship and supervised visits. The rules live in
// models/MinorSupervisionModel.ts (re-exported here for booking and reader flows) and the
// sponsor-request queries in models/SponsorRequestModel.ts.

import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { transaction, type Database } from './db.js';
import { AppError, dateOfBirthField, emailField, integerId, positiveId, textField } from './domain.js';
import { authRateLimit, authState, requireCsrf } from './middleware/auth.js';
import { anySignedIn, requireStaffPermission } from './middleware/permissions.js';
import { StaffModel } from './models/StaffModel.js';
import { EligibilityModel } from './models/EligibilityModel.js';
import { MemberModel } from './models/MemberModel.js';
import { MinorSupervision, MinorSupervisionModel } from './models/MinorSupervisionModel.js';
import { SponsorRequestModel } from './models/SponsorRequestModel.js';
import { enqueueNotification } from './notifications/store.js';

export { MinorSupervision };

export function minorSupervisionRoutes(pool:Pool,zone:string) {
  const r=Router();
  r.get('/me/supervision',anySignedIn,async(_req,res)=>res.json({data:await new MinorSupervision(pool,zone).summary(authState(res).user.id)}));
  r.post('/me/visit/check-out',anySignedIn,requireCsrf,async(_req,res)=>res.json({data:await transaction(pool,db=>new MinorSupervision(db,zone).checkout(authState(res).user.id))}));
  // Adult-initiated, minor-confirmed links. Lock order matches the staff route:
  // minor user row, adult user row, sponsor row, then the minor's open visit.
  // Payloads carry first names only, never either account's email.
  const notify=(db:Database,userId:number,id:number,kind:'received'|'accepted'|'declined',payload:Record<string,string>)=>
    enqueueNotification(db,{userId,kind:`sponsor_request_${kind}` as const,dedupeKey:`sponsor-request:${id}:${kind}`,payload});
  // Bounds date-of-birth guessing against a known email. The per-address limiter matches sign-in;
  // the per-adult and per-email budgets live in the database so they survive restarts and races.
  const limitMessage='Too many sponsor requests. Please try again tomorrow or ask staff to link the account.';
  const requestLimit=authRateLimit({limit:20,message:'Too many sponsor requests. Please wait 15 minutes and try again.'});
  const reserveAttempt=(adultId:number,emailHash:string)=>transaction(pool,async db=>{
    const requests=new SponsorRequestModel(db,zone);
    await requests.lockAttempts(adultId,emailHash);
    const counts=await requests.attemptCounts(adultId,emailHash);
    // Per day: 10 attempts per adult, 5 misses per adult+email. Per target email: 15 misses in
    // 30 days across all adults, so the guess budget does not grow with extra accounts or time;
    // a locked-out parent can still be linked by staff at the front desk.
    if (counts.adult>=10 || counts.pair>=5 || counts.email>=15) throw new AppError(429,'RATE_LIMITED',limitMessage);
    return requests.recordAttempt(adultId,emailHash);
  });
  r.get('/me/minors',anySignedIn,async(_req,res)=>res.json({data:await new MinorSupervision(pool,zone).minors(authState(res).user.id)}));
  r.post('/me/minors/requests',anySignedIn,requireCsrf,requestLimit,async(req,res)=>{
    const me=authState(res).user.id,email=emailField(req.body.email),dob=dateOfBirthField(req.body.dob);
    if (!await new MinorSupervision(pool,zone).isAdult(me)) throw new AppError(403,'ADULT_REQUIRED','Only active accounts aged 18 or older can sponsor a minor.');
    const attempt=await reserveAttempt(me,createHash('sha256').update(email.toLowerCase()).digest('hex'));
    // Recorded after the transaction releases its client, so a later 409 still counts the
    // details as matched without the request holding two pool connections at once.
    let matched=false;
    const data=await transaction(pool,async db=>{
      const service=new MinorSupervision(db,zone),adultRequired=()=>new AppError(403,'ADULT_REQUIRED','Only active accounts aged 18 or older can sponsor a minor.');
      const records=new MinorSupervisionModel(db,zone),requests=new SponsorRequestModel(db,zone);
      if (!await service.isAdult(me)) throw adultRequired();
      // One answer for every mismatch so the form cannot reveal which accounts exist.
      const minor=await requests.lockMatchingMinor(email,dob);
      if (!minor) throw new AppError(404,'NOT_FOUND','No under-18 account matches that email and date of birth.');
      matched=true;
      const adult=await requests.lockRequestingAdult(me);
      if (!adult) throw adultRequired();
      if (await records.isSponsoredBy(minor.id,me))
        throw new AppError(409,'ALREADY_LINKED','You already sponsor this account.');
      // Self-service only fills an empty sponsor slot; replacing a sponsor stays a staff decision.
      if (await records.hasSponsor(minor.id))
        throw new AppError(409,'SPONSOR_EXISTS','This account already has a sponsoring adult. Staff at the front desk can change it.');
      if (await requests.hasPending(minor.id,me))
        throw new AppError(409,'REQUEST_PENDING','You already have a pending request for this account.');
      const row=await requests.create(minor.id,me);
      await notify(db,minor.id,row.id,'received',{adultName:adult.firstname});
      return {id:row.id,minorName:minor.name,createdAt:row.createdAt};
    }).finally(async()=>{
      if (matched) await new SponsorRequestModel(pool,zone).markAttemptMatched(attempt);
    });res.status(201).json({data});
  });
  r.post('/me/minors/requests/:id/cancel',anySignedIn,requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,id=positiveId(req.params.id);
    const data=await transaction(pool,async db=>{
      const records=new MinorSupervisionModel(db,zone),requests=new SponsorRequestModel(db,zone);
      const found=await requests.pendingSentBy(id,me);
      if (found) await records.lockUser(found.minor_id);
      if (!found || !await requests.cancel(id)) throw new AppError(404,'NOT_FOUND','No pending request found.');
      await requests.withdrawNotices([id]);
      return new MinorSupervision(db,zone).minors(me);
    });res.json({data});
  });
  r.post('/me/minors/:minorId/unlink',anySignedIn,requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,minor=integerId(req.params.minorId,'Minor');
    const data=await transaction(pool,async db=>{
      const records=new MinorSupervisionModel(db,zone);
      await records.lockUser(minor);
      const existing=await records.sponsorshipBy(minor,me);
      if (!existing) throw new AppError(404,'NOT_FOUND','You do not sponsor this account.');
      if (await records.hasOpenVisit(minor)) throw new AppError(409,'CHECK_OUT_FIRST','Check out the minor before removing your sponsorship.');
      await records.unlinkSponsor(minor);
      await new StaffModel(db,zone).audit(me,minor,'minor.sponsor_unlinked','user',minor,'Sponsoring adult removed their link',existing,null);
      return new MinorSupervision(db,zone).minors(me);
    });res.json({data});
  });
  for (const action of ['accept','decline'] as const) r.post(`/me/sponsor-requests/:id/${action}`,anySignedIn,requireCsrf,async(req,res)=>{
    const me=authState(res).user.id,id=positiveId(req.params.id);
    const data=await transaction(pool,async db=>{
      const service=new MinorSupervision(db,zone);
      const records=new MinorSupervisionModel(db,zone),requests=new SponsorRequestModel(db,zone);
      await records.lockUser(me);
      const request=await requests.lockPendingFor(id,me);
      if (!request) throw new AppError(404,'NOT_FOUND','No pending sponsor request found.');
      if (action==='decline') {
        await requests.decline(id);
        await requests.withdrawNotices([id]);
        await notify(db,request.adult_id,id,'declined',{minorName:request.minorName});
        return service.summary(me);
      }
      // Re-validate everything the staff link route checks; the request may be stale.
      if (!await service.isMinor(me)) throw new AppError(409,'MINOR_REQUIRED','Only accounts under 18 need a sponsoring adult.');
      if (!await requests.lockSponsorCandidate(request.adult_id,me))
        throw new AppError(409,'ADULT_REQUIRED','This adult can no longer sponsor you. Ask them to check their account.');
      const existing=await records.sponsorship(me);
      if (existing && existing.adult_id!==request.adult_id)
        throw new AppError(409,'SPONSOR_EXISTS','You already have a sponsoring adult. Ask staff at the front desk to change it.');
      if (await records.hasOpenVisit(me)) throw new AppError(409,'CHECK_OUT_FIRST','Check out before changing your sponsoring adult.');
      await records.linkSponsor(me,request.adult_id);
      // The accepted request resolves; every other pending request for this minor is withdrawn.
      const resolved=await requests.resolveAccepted(me,id);
      await requests.withdrawNotices(resolved);
      await notify(db,request.adult_id,id,'accepted',{minorName:request.minorName});
      await new StaffModel(db,zone).audit(me,me,'minor.sponsor_linked','user',me,'Minor accepted sponsor request',existing ?? null,{adultId:request.adult_id,requestId:id});
      return service.summary(me);
    });res.json({data});
  });
  const base='/admin/users/:id/supervision';
  // The prefix gate covers every method; each route also names the requirement (confirmed once).
  const supervise=requireStaffPermission(pool,'user','update');
  r.use(base,supervise);
  r.get(base,supervise,async(req,res)=>res.json({data:await new MinorSupervision(pool,zone).summary(positiveId(req.params.id))}));
  const guardTarget = async (db:Database,actorId:number,id:number) => {
    // Match existing staff account-management policy and lock order.
    await new MinorSupervisionModel(db,zone).lockStaffWrites();
    const model=new StaffModel(db,zone),target=await model.person(id,true),actor=await model.person(actorId);
    if (!target) throw new AppError(404,'NOT_FOUND','User not found.');
    if (target.roles.some((role:string)=>role==='staff'||role==='admin') && !actor?.roles.includes('admin'))
      throw new AppError(403,'ADMIN_REQUIRED','Only administrators can manage staff accounts.');
  };
  r.post(base,supervise,requireCsrf,async(req,res)=>{
    const id=positiveId(req.params.id),adult=positiveId(req.body.adultId),revision=req.body.revision;
    const reason=textField(req.body.reason,'Reason',500);
    if(req.body.consent!==true) throw new AppError(400,'CONSENT_REQUIRED','Verify that the adult agrees to sponsor this minor.');
    const data=await transaction(pool,async db=>{
      await guardTarget(db,authState(res).user.id,id);
      const service=new MinorSupervision(db,zone),records=new MinorSupervisionModel(db,zone);
      await records.lockUser(id);
      if (!await service.isMinor(id)) throw new AppError(400,'MINOR_REQUIRED','Choose an account under 18.');
      const eligible=await records.lockEligibleAdult(adult,id);
      if (!eligible) throw new AppError(400,'ADULT_REQUIRED','Choose an active adult account aged 18 or older.');
      const existing=await records.sponsorship(id);
      if ((existing?.revision ?? 0)!==revision) throw new AppError(409,'STALE_RECORD','Refresh the sponsor record before saving.');
      if (await records.hasOpenVisit(id))
        throw new AppError(409,'CHECK_OUT_FIRST','Check out the minor before changing their sponsoring adult.');
      await records.linkSponsor(id,adult);
      await new StaffModel(db,zone).audit(authState(res).user.id,id,'minor.sponsor_linked','user',id,reason,existing ?? null,{adultId:adult});
      return service.summary(id);
    });res.json({data});
  });
  for (const action of ['check-in','check-out']) r.post(`${base}/${action}`,supervise,requireCsrf,async(req,res)=>{
    // A desk check-in/out needs no explanation; a note is kept when staff give one.
    const note=req.body.reason;
    const reason=note==null||(typeof note==='string'&&!note.trim())
      ? (action==='check-in' ? 'Checked in at the front desk' : 'Checked out at the front desk')
      : textField(note,'Reason',500);
    const id=positiveId(req.params.id);
    const data=await transaction(pool,async db=>{
      await guardTarget(db,authState(res).user.id,id);
      const service=new MinorSupervision(db,zone),records=new MinorSupervisionModel(db,zone);
      if (action==='check-in' && !await records.lockActiveAccount(id))
        throw new AppError(403,'ACCESS_BLOCKED','This account does not have access.');
      if (action==='check-in') {
        const model=new EligibilityModel(db,zone),entitlement=await model.entitlement(id,new Date()),waivers=await model.waivers(id,'facility');
        if (!entitlement.membership && !entitlement.dayPass) throw new AppError(403,'MEMBERSHIP_REQUIRED','Each visitor needs a membership or day pass.');
        if (!waivers.length || waivers.some(w=>!w.signed)) throw new AppError(403,'WAIVER_REQUIRED','Sign current required policies first.');
        const building=req.body.buildingId==null ? await service.arrivalBuilding(id) : positiveId(req.body.buildingId);
        const place=await records.availableBuilding(building);
        if (!place) throw new AppError(409,'RESOURCE_UNAVAILABLE','This building is unavailable.');
        // Record the arrival as reader and portal check-ins do, so it counts in "Checked in
        // today", attendance reports and recent check-ins. This also starts the visit.
        await new MemberModel(db,zone).createCheckIn(id,place.name,null,building,null,null,'desk');
      } else await service.checkout(id);
      await new StaffModel(db,zone).audit(authState(res).user.id,id,`visit.${action}`,'user',id,reason,null,{action});
      return service.summary(id);
    });res.json({data});
  });
  return r;
}
