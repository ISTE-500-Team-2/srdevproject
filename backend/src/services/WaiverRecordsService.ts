import type { Pool } from 'pg';
import { transaction, type Database } from '../db.js';
import { AppError } from '../domain.js';
import { UserModel } from '../models/UserModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { enqueueNotification, getNotificationPreferences } from '../notifications/store.js';
import { reminderDates } from '../notifications/scheduler.js';

export interface SignedWaiverRecord {
  id:number;waiverId:number;name:string;version:string;signedAt:Date;expiresAt:Date|null;approved:boolean;copyAvailable:boolean;
}
export class WaiverRecordsService {
  constructor(private pool:Pool) {}
  private async authorize(db:Database,actorId:number,userId:number,write=false) {
    const actor=await new UserModel(db).findById(actorId);
    if(!actor || actor.status!=='active')throw new AppError(403,'FORBIDDEN','Account access is required.');
    if(!write && actorId===userId)return;
    if(!actor.roles.includes('admin') || !await new PermissionModel(db).allows(actor,'waiver',write?'update':'read'))
      throw new AppError(403,'ADMIN_REQUIRED','Administrator permission is required.');
  }
  async list(actorId:number,userId:number):Promise<SignedWaiverRecord[]> {
    await this.authorize(this.pool,actorId,userId);
    return (await this.pool.query<SignedWaiverRecord>(`SELECT uw.userwaiverid AS id,uw.waiverid AS "waiverId",
      COALESCE(o.payload->>'waiverName',w.name) AS name,COALESCE(o.payload->>'waiverVersion',w.version) AS version,
      uw.signdate AT TIME ZONE 'UTC' AS "signedAt",uw.expires_at AS "expiresAt",uw.approval AS approved,
      (o.id IS NOT NULL AND o.payload ?& ARRAY['waiverName','waiverVersion','waiverText','signature','signedAt']) AS "copyAvailable"
      FROM user_waiver uw JOIN waiver w USING(waiverid)
      LEFT JOIN app_notification_outbox o ON o.dedupe_key='waiver-signed:'||uw.userwaiverid AND o.userid=uw.userid AND o.kind='waiver_signed'
      WHERE uw.userid=$1 ORDER BY uw.signdate DESC,uw.userwaiverid DESC LIMIT 200`,[userId])).rows;
  }
  async copy(actorId:number,userId:number,signatureId:number) {
    await this.authorize(this.pool,actorId,userId);
    const row=(await this.pool.query(`SELECT o.payload FROM user_waiver uw
      LEFT JOIN app_notification_outbox o ON o.dedupe_key='waiver-signed:'||uw.userwaiverid AND o.userid=uw.userid AND o.kind='waiver_signed'
      WHERE uw.userid=$1 AND uw.userwaiverid=$2`,[userId,signatureId])).rows[0];
    if(!row)throw new AppError(404,'NOT_FOUND','Signed waiver not found.');
    const p=row.payload;
    if(!p || !['waiverName','waiverVersion','waiverText','signature','signedAt'].every(k=>typeof p[k]==='string'))
      throw new AppError(409,'SIGNED_COPY_UNAVAILABLE','This legacy signature has no preserved signed-text copy. Ask staff for its original record.');
    return {fileName:`signed-waiver-${signatureId}.txt`,contentType:'text/plain;charset=utf-8',content:[
      'SIGNED WAIVER COPY',`Waiver: ${p.waiverName}`,`Version: ${p.waiverVersion}`,`Signed by: ${p.signature}`,
      `Signed at: ${p.signedAt}`,'','Accepted policy text:',p.waiverText,'',
      'This copy reproduces the text and electronic agreement recorded when signed. It does not certify current access eligibility.'
    ].join('\n')};
  }
  async expiry(actorId:number,userId:number,signatureId:number,expiresAt:string|null,expectedExpiry:string|null,reason:string) {
    return transaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'))");
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE',[actorId]);
      await this.authorize(db,actorId,userId,true);
      const row=(await db.query(`SELECT uw.userwaiverid AS id,uw.signdate AT TIME ZONE 'UTC' AS "signedAt",uw.expires_at AS "expiresAt",uw.approval,w.name
        FROM user_waiver uw JOIN waiver w USING(waiverid) WHERE uw.userid=$1 AND uw.userwaiverid=$2 FOR UPDATE OF uw`,[userId,signatureId])).rows[0];
      if(!row)throw new AppError(404,'NOT_FOUND','Signed waiver not found.');
      const previous=row.expiresAt ? new Date(row.expiresAt).toISOString():null;
      if(previous!==expectedExpiry)throw new AppError(409,'STALE_RECORD','This expiration changed. Reload before saving.');
      if(expiresAt && new Date(expiresAt)<=new Date(row.signedAt))throw new AppError(400,'INVALID_EXPIRY','Expiration must be after the recorded signing time.');
      if(previous===expiresAt)return {expiresAt:previous};
      await db.query('UPDATE user_waiver SET expires_at=$3 WHERE userid=$1 AND userwaiverid=$2',[userId,signatureId,expiresAt]);
      await new StaffModel(db).audit(actorId,userId,'waiver_expiry_updated','user_waiver',signatureId,reason,{expiresAt:previous},{expiresAt});
      // Existing queued reminders are superseded, but never rewrite accepted copies.
      await db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=counts_for_sla AND deadline_at<NOW(),updated_at=NOW()
        WHERE userid=$1 AND status='pending' AND payload->>'sourceType'='waiver' AND payload->>'sourceId'=$2`,[userId,String(signatureId)]);
      if(expiresAt && row.approval) {
        const prefs=await getNotificationPreferences(db,userId);
        const expiry=new Date(expiresAt);
        await enqueueNotification(db,{userId,kind:'waiver_expiring',dedupeKey:`waiver-expiring:${signatureId}:${expiry.toISOString()}`,
          ...reminderDates(expiry,prefs.timeZone),payload:{sourceType:'waiver',sourceId:signatureId,expiresAt:expiry.toISOString(),name:row.name}});
        // An administrator can clear and later restore the same date. Revive only
        // a canceled, never-accepted reminder, never an accepted or opted-out one.
        if(prefs.enabled) await db.query(`UPDATE app_notification_outbox SET status='pending',counts_for_sla=true,updated_at=NOW()
          WHERE dedupe_key=$1 AND status='obsolete' AND accepted_at IS NULL`,[`waiver-expiring:${signatureId}:${expiry.toISOString()}`]);
      }
      return {expiresAt};
    });
  }
}
