// Enforces adult sponsorship and same-building visits for minors; booking and reader flows call
// these rules rather than duplicating them. MinorSupervisionModel holds the sponsor-link, visit and
// lock queries the supervision routes run inside their transactions.

import type { Database } from '../db.js';
import { AppError } from '../domain.js';
import { EligibilityModel } from './EligibilityModel.js';
import { DEFAULT_BUILDING_ID } from '../facility.js';

/** Active account aged 18+; `$${zone}` is the time-zone parameter. */
export const adultSql=(zone:number)=>`dob IS NOT NULL AND dob::date<=((now() AT TIME ZONE $${zone})::date-INTERVAL '18 years')::date
  AND status='active' AND accessstatus='active'`;

export class MinorSupervision {
  constructor(readonly db: Database, readonly zone = 'America/New_York') {}
  async isMinor(id: number) {
    return (await this.db.query(`SELECT dob IS NOT NULL AND dob::date>((now() AT TIME ZONE $2)::date-INTERVAL '18 years')::date AS minor
      FROM "user" WHERE userid=$1`, [id,this.zone])).rows[0]?.minor === true;
  }
  /** The linked sponsor when they are an active adult, which is all advance class enrollment needs. */
  async linkedSponsor(id: number, lock = false) {
    return (await this.db.query<{ id: number }>(`SELECT s.adult_id AS id FROM app_minor_sponsor s
      JOIN "user" u ON u.userid=s.adult_id WHERE s.minor_id=$1 AND ${adultSql(2)}
      ${lock ? 'FOR SHARE OF s,u' : ''}`,[id,this.zone])).rows[0] ?? null;
  }
  /** Advance class enrollment needs a valid link; arrival still checks adult presence. */
  async requireLinkedSponsor(id: number) {
    if (!await this.isMinor(id)) return null;
    const sponsor = await this.linkedSponsor(id, true);
    if (!sponsor) throw new AppError(403,'SPONSOR_REQUIRED','Link an active sponsoring adult before enrolling.');
    return sponsor;
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
    const waivers = await eligibility.waivers(sponsor.id, 'facility');
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
  /**
   * Where a desk arrival with no building named belongs: the member's visit today, then a minor's
   * present sponsor's building, then the default. Never moves a visit to another building.
   */
  async arrivalBuilding(id:number) {
    const minor=await this.isMinor(id);
    const visit=(await this.db.query<{building:number}>(`SELECT v.building_id AS building FROM app_facility_visit v
      WHERE v.checked_out_at IS NULL AND (v.checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date
        AND (v.user_id=$1 OR ($3 AND v.user_id=(SELECT adult_id FROM app_minor_sponsor WHERE minor_id=$1)))
      ORDER BY v.user_id=$1 DESC LIMIT 1`,[id,this.zone,minor])).rows[0];
    return visit?.building ?? DEFAULT_BUILDING_ID;
  }
  async startVisit(id:number,buildingId:number) {
    const sponsor = await this.requireSponsor(id,buildingId);
    // One open visit, with stale previous-day visits explicitly ended before starting anew.
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext(\'arbor-visit\'),$1)',[id]);
    await this.closeStale(id);
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
  /** Ends open visits from previous days; summary and sponsor checks only see today's. */
  async closeStale(id:number) {
    // now() is transaction start; a visit inserted after it commits must not end before it began.
    await this.db.query(`UPDATE app_facility_visit SET checked_out_at=GREATEST(clock_timestamp(),checked_in_at) WHERE user_id=$1 AND checked_out_at IS NULL
      AND (checked_in_at AT TIME ZONE $2)::date<>(now() AT TIME ZONE $2)::date`,[id,this.zone]);
  }
  async checkout(id:number) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-visit'),$1)",[id]);
    // Lock the adult visit first: concurrent minor access/booking holds the same row shared.
    const parent = await this.db.query('SELECT id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id]);
    // Minor visits may have been inserted after this transaction began (see closeStale).
    const result=await this.db.query(`UPDATE app_facility_visit SET checked_out_at=GREATEST(clock_timestamp(),checked_in_at)
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
    // Lets the member see before registering that a class signup would be refused.
    const sponsorEligible=minor && sponsor ? !!await this.linkedSponsor(id) : false;
    return {isMinor:minor,marker:minor?'Under 18':null,sponsor,sponsorEligible,visit,pendingRequests};
  }
  async isAdult(id:number) {
    return !!(await this.db.query(`SELECT 1 FROM "user" WHERE userid=$1 AND ${adultSql(2)}`,[id,this.zone])).rowCount;
  }
  /**
   * Minors an adult sponsors (with today's open visit), the adult's pending outgoing requests,
   * and whether they may send a new one: older accounts have no date of birth on file.
   */
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
    const self=(await this.db.query(`SELECT dob IS NOT NULL AS "dobOnFile",(${adultSql(2)}) AS "canSponsor"
      FROM "user" WHERE userid=$1`,[adultId,this.zone])).rows[0];
    return {minors,requests,canSponsor:self?.canSponsor===true,dobOnFile:self?.dobOnFile===true};
  }
}

/**
 * Row locks, sponsor links and desk checks for the supervision routes. Each method runs on the
 * connection it is given, so callers keep their transaction and lock order.
 */
export class MinorSupervisionModel {
  constructor(readonly db: Database, readonly zone = 'America/New_York') {}
  async lockUser(id:number) {
    await this.db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE',[id]);
  }
  /** Stale previous-day visits are ended first, as startVisit does, so they cannot block changes the summary hides. */
  async hasOpenVisit(id:number) {
    await new MinorSupervision(this.db,this.zone).closeStale(id);
    return !!(await this.db.query('SELECT id FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL FOR UPDATE',[id])).rowCount;
  }
  /** The minor's sponsor row when this adult holds it, locked for update. */
  async sponsorshipBy(minorId:number,adultId:number) {
    return (await this.db.query('SELECT * FROM app_minor_sponsor WHERE minor_id=$1 AND adult_id=$2 FOR UPDATE',[minorId,adultId])).rows[0];
  }
  /** The minor's sponsor row, whoever holds it, locked for update. */
  async sponsorship(minorId:number) {
    return (await this.db.query('SELECT * FROM app_minor_sponsor WHERE minor_id=$1 FOR UPDATE',[minorId])).rows[0];
  }
  async isSponsoredBy(minorId:number,adultId:number) {
    return !!(await this.db.query('SELECT 1 FROM app_minor_sponsor WHERE minor_id=$1 AND adult_id=$2',[minorId,adultId])).rowCount;
  }
  async hasSponsor(minorId:number) {
    return !!(await this.db.query('SELECT 1 FROM app_minor_sponsor WHERE minor_id=$1',[minorId])).rowCount;
  }
  async linkSponsor(minorId:number,adultId:number) {
    await this.db.query(`INSERT INTO app_minor_sponsor(minor_id,adult_id) VALUES($1,$2) ON CONFLICT(minor_id)
        DO UPDATE SET adult_id=EXCLUDED.adult_id,revision=app_minor_sponsor.revision+1,updated_at=now()`,[minorId,adultId]);
  }
  async unlinkSponsor(minorId:number) {
    await this.db.query('DELETE FROM app_minor_sponsor WHERE minor_id=$1',[minorId]);
  }
  /** Match existing staff account-management policy and lock order. */
  async lockStaffWrites() {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-staff-writes'))");
  }
  /** Whether another active account aged 18+ can sponsor the minor, held shared. */
  async lockEligibleAdult(adultId:number,minorId:number) {
    return !!(await this.db.query(`SELECT userid FROM "user" WHERE userid=$1 AND userid<>$2 AND dob IS NOT NULL
        AND dob::date<=((now() AT TIME ZONE $3)::date-INTERVAL '18 years')::date AND status='active' AND accessstatus='active' FOR SHARE`,[adultId,minorId,this.zone])).rowCount;
  }
  /** Whether the account is active with access, held shared. */
  async lockActiveAccount(id:number) {
    return !!(await this.db.query('SELECT userid FROM "user" WHERE userid=$1 AND status=\'active\' AND accessstatus=\'active\' FOR SHARE',[id])).rowCount;
  }
  /** An available building, held shared. */
  async availableBuilding(buildingId:number) {
    return (await this.db.query<{name:string}>("SELECT name FROM building WHERE buildingid=$1 AND status='available' FOR SHARE",[buildingId])).rows[0];
  }
}
