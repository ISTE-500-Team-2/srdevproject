// Adult-initiated, minor-confirmed sponsor requests: the attempt budget that bounds date-of-birth
// guessing, the request rows themselves and their pending notices. Methods run on the connection
// they are given, so the routes keep their transactions and lock order.

import type { Database } from '../db.js';
import { adultSql } from './MinorSupervisionModel.js';

export class SponsorRequestModel {
  constructor(readonly db: Database, readonly zone = 'America/New_York') {}
  /** Serialize per adult and per target so concurrent requests cannot both pass the check. */
  async lockAttempts(adultId:number,emailHash:string) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-sponsor-attempt-adult'),$1)",[adultId]);
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-sponsor-attempt-email'),hashtext($1))",[emailHash]);
  }
  async attemptCounts(adultId:number,emailHash:string) {
    return (await this.db.query<{adult:number;pair:number;email:number}>(`SELECT
        count(*) FILTER (WHERE adult_id=$1 AND created_at>now()-interval '1 day')::int AS adult,
        count(*) FILTER (WHERE adult_id=$1 AND email_hash=$2 AND NOT matched AND created_at>now()-interval '1 day')::int AS pair,
        count(*) FILTER (WHERE email_hash=$2 AND NOT matched)::int AS email
      FROM app_minor_sponsor_attempt WHERE created_at>now()-interval '30 days' AND (adult_id=$1 OR email_hash=$2)`,[adultId,emailHash])).rows[0]!;
  }
  async recordAttempt(adultId:number,emailHash:string) {
    return (await this.db.query('INSERT INTO app_minor_sponsor_attempt(adult_id,email_hash) VALUES($1,$2) RETURNING id',[adultId,emailHash])).rows[0]!.id as string;
  }
  async markAttemptMatched(attemptId:string) {
    await this.db.query('UPDATE app_minor_sponsor_attempt SET matched=true WHERE id=$1',[attemptId]);
  }
  /** The active under-18 account with this email and date of birth, locked for update. */
  async lockMatchingMinor(email:string,dob:string) {
    return (await this.db.query(`SELECT userid AS id,firstname AS name FROM "user"
        WHERE lower(email)=$1 AND dob IS NOT NULL AND dob::date=$2::date AND status='active' AND accessstatus='active'
        AND dob::date>((now() AT TIME ZONE $3)::date-INTERVAL '18 years')::date FOR UPDATE`,[email,dob,this.zone])).rows[0];
  }
  /** The requesting adult's first name while they remain an active adult, held shared. */
  async lockRequestingAdult(adultId:number) {
    return (await this.db.query(`SELECT firstname FROM "user" WHERE userid=$1 AND ${adultSql(2)} FOR SHARE`,[adultId,this.zone])).rows[0];
  }
  async hasPending(minorId:number,adultId:number) {
    return !!(await this.db.query("SELECT 1 FROM app_minor_sponsor_request WHERE minor_id=$1 AND adult_id=$2 AND status='pending'",[minorId,adultId])).rowCount;
  }
  async create(minorId:number,adultId:number) {
    return (await this.db.query(`INSERT INTO app_minor_sponsor_request(minor_id,adult_id) VALUES($1,$2)
        RETURNING id::int AS id,created_at AS "createdAt"`,[minorId,adultId])).rows[0]!;
  }
  /** The minor on a pending request this adult sent. */
  async pendingSentBy(id:number,adultId:number) {
    return (await this.db.query("SELECT minor_id FROM app_minor_sponsor_request WHERE id=$1 AND adult_id=$2 AND status='pending'",[id,adultId])).rows[0];
  }
  /** Whether a still-pending request was cancelled. */
  async cancel(id:number) {
    return !!(await this.db.query(`UPDATE app_minor_sponsor_request SET status='cancelled',resolved_at=now()
        WHERE id=$1 AND status='pending'`,[id])).rowCount;
  }
  /** A pending request addressed to this minor, with the minor's first name, locked for update. */
  async lockPendingFor(id:number,minorId:number) {
    return (await this.db.query(`SELECT adult_id,(SELECT firstname FROM "user" WHERE userid=minor_id) AS "minorName"
        FROM app_minor_sponsor_request WHERE id=$1 AND minor_id=$2 AND status='pending' FOR UPDATE`,[id,minorId])).rows[0];
  }
  async decline(id:number) {
    await this.db.query("UPDATE app_minor_sponsor_request SET status='declined',resolved_at=now() WHERE id=$1",[id]);
  }
  /** Whether the requesting adult is still another active adult account, held shared. */
  async lockSponsorCandidate(adultId:number,minorId:number) {
    return !!(await this.db.query(`SELECT userid FROM "user" WHERE userid=$1 AND userid<>$3 AND ${adultSql(2)} FOR SHARE`,[adultId,this.zone,minorId])).rowCount;
  }
  /** The accepted request resolves; every other pending request for this minor is withdrawn. Returns every resolved id. */
  async resolveAccepted(minorId:number,acceptedId:number) {
    return (await this.db.query(`UPDATE app_minor_sponsor_request SET status=CASE WHEN id=$2 THEN 'accepted' ELSE 'cancelled' END,resolved_at=now()
        WHERE minor_id=$1 AND status='pending' RETURNING id::int`,[minorId,acceptedId])).rows.map(r=>r.id as number);
  }
  /** A request resolved before its email went out no longer needs one. */
  async withdrawNotices(ids:number[]) {
    await this.db.query(`UPDATE app_notification_outbox SET status='obsolete',counts_for_sla=false,updated_at=now()
    WHERE dedupe_key=ANY($1::text[]) AND status='pending'`,[ids.map(id=>`sponsor-request:${id}:received`)]);
  }
}
