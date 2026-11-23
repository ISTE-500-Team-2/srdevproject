// Canonical account, entitlement, policy and equipment checks used by check-in, bookings and reader
// decisions.

import { MinorSupervision } from "../minorSupervision.js";
import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { accessStatusCode, entitlementCode, waiverCode } from "../eligibility.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import type { EquipmentRecord } from "../models/EquipmentModel.js";
import { EXPIRATION_LOOKAHEAD_DAYS } from "../notifications/scheduler.js";
import { DEFAULT_BUILDING_ID } from "../facility.js";
import type { PolicyScope } from "../staffDomain.js";

export interface AccessTarget {
  buildingId?: number;
  roomId?: number;
  equipmentId?: number;
  /** A rented studio (`app_studio`), opened only for its current paid rental. */
  studioId?: number;
}

export class AccessService {
  readonly eligibility: EligibilityModel;
  constructor(private db: Database, private timeZone: string) {
    this.eligibility = new EligibilityModel(db,timeZone);
  }

  /**
   * Lock and check account/facility status so a concurrent staff restriction cannot be ignored by
   * the current transaction.
   */
  async assertActiveUser(userId: number) {
    const user = (await this.db.query<{status: string; accessstatus: string}>(
      'SELECT status,accessstatus FROM "user" WHERE userid=$1 FOR SHARE',[userId])).rows[0];
    if (user?.status !== 'active')
      throw new AppError(403,'ACCOUNT_INACTIVE','This account does not currently have access.');
    if (accessStatusCode(user.accessstatus))
      throw new AppError(403,'ACCESS_BLOCKED','Facility access is suspended or revoked. Contact staff.');
  }

  /**
   * Require membership or day-pass coverage through the full requested interval and return which
   * alternatives cover it.
   */
  async assertEntitlement(userId: number, start: Date, end = start) {
    const value = await this.eligibility.entitlement(userId,start,end);
    if (entitlementCode(value))
      throw new AppError(403,'MEMBERSHIP_REQUIRED','An active membership or valid day pass is required for this time.');
    return value;
  }

  /**
   * Reject missing policy configuration as well as missing signatures; an empty policy catalog must
   * not silently grant access.
   */
  async assertWaivers(userId: number, scope: PolicyScope = 'facility', through?: Date) {
    const waivers = await this.eligibility.waivers(userId, scope, through);
    const code = waiverCode(waivers);
    if (code === 'WAIVERS_NOT_CONFIGURED')
      throw new AppError(409,'WAIVERS_NOT_CONFIGURED',scope === 'equipment'
        ? 'Staff need to configure the required equipment waivers before this equipment can be used.'
        : 'Staff need to configure the required facility policies before access can be granted.');
    if (code === 'WAIVER_REQUIRED')
      throw new AppError(403,'WAIVER_REQUIRED',through
        ? this.lapsingWaiverMessage(waivers) ?? `Sign all current required ${scope === 'equipment' ? 'equipment waivers' : 'facility policies'} first. They must remain valid through your reservation.`
        : `Sign all current required ${scope === 'equipment' ? 'equipment waivers' : 'facility policies'} first.`);
    return waivers;
  }

  /**
   * A signature that is valid today but runs out before the reservation ends can only be renewed in
   * its last days (MemberModel.signWaiver), so say when, rather than send the member to a waivers
   * page that has nothing to sign yet.
   */
  private lapsingWaiverMessage(waivers: {name: string; signed: boolean; expiresAt: Date | null}[]) {
    const now = Date.now();
    const unsigned = waivers.filter(w => !w.signed);
    // Anything never signed, outdated or already expired needs signing now: the usual message.
    if (unsigned.some(w => !w.expiresAt || w.expiresAt.getTime() <= now)) return null;
    const lapsing = unsigned[0];
    if (!lapsing?.expiresAt) return null;
    const ends = new Intl.DateTimeFormat('en-US',{timeZone:this.timeZone,month:'short',day:'numeric',year:'numeric'}).format(lapsing.expiresAt);
    const renewable = lapsing.expiresAt.getTime() - EXPIRATION_LOOKAHEAD_DAYS * 86_400_000 <= now;
    return `Your ${lapsing.name} signature runs out on ${ends}, before this reservation ends. ` + (renewable
      ? 'Sign it again under Certifications & waivers, then book.'
      : `You can sign it again in its last ${EXPIRATION_LOOKAHEAD_DAYS} days, or book a time before then.`);
  }

  async assertEquipmentWaivers(userId: number, through?: Date) {
    await this.assertWaivers(userId, 'facility', through);
    return this.assertWaivers(userId, 'equipment', through);
  }

  /**
   * Check training through the booking end and, where required, both facility and equipment policy
   * signatures.
   */
  async assertEquipmentRequirements(userId: number, equipment: EquipmentRecord, through: Date) {
    if (equipment.certId && !await this.eligibility.certification(userId, equipment.certId, through))
      throw new AppError(403, 'CERTIFICATION_REQUIRED', `A current ${equipment.certification ?? 'equipment'} certification is required.`);
    return equipment.waiverRequired ? this.assertEquipmentWaivers(userId, through) : [];
  }

  /**
   * Resolve an explicit building or the member's current visit; ambiguous multi-building check-ins
   * require a choice.
   */
  async facilityContext(userId: number, requestedBuildingId?: number) {
    const buildings = (await this.db.query<{id: number; name: string; status: string}>(
      'SELECT buildingid AS id,name,status FROM building ORDER BY name,buildingid')).rows;
    const visit = (await this.db.query<{buildingId: number}>(`SELECT building_id AS "buildingId"
      FROM app_facility_visit WHERE user_id=$1 AND checked_out_at IS NULL
        AND (checked_in_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date`,
      [userId,this.timeZone])).rows[0];
    // An unspecified target must not transfer a current visit. With multiple
    // buildings and no current visit, the person at the desk must choose one.
    const buildingId = requestedBuildingId ?? visit?.buildingId ?? (buildings.length === 1 ? buildings[0]!.id : null);
    return {buildings, buildingId};
  }

  // The caller keeps the decision and check-in in one transaction.
  /**
   * Resolve building/room/equipment access through one path so reader decisions and desk checks
   * enforce the same requirements.
   */
  async accessForTarget(userId: number, target: AccessTarget, at = new Date()) {
    await this.assertActiveUser(userId);
    const entitlement = await this.assertEntitlement(userId,at);
    await this.assertWaivers(userId);
    if (target.studioId !== undefined) return this.studioAccess(userId, target.studioId, entitlement, at);
    let buildingId = target.buildingId;
    if (!target.roomId && !target.equipmentId && buildingId === undefined) {
      buildingId = (await this.facilityContext(userId)).buildingId ?? undefined;
      if (buildingId === undefined)
        throw new AppError(400,'BUILDING_REQUIRED','Choose the building where you are arriving.');
    }
    let location: string | undefined;
    if (target.roomId || target.equipmentId) {
      const table = target.roomId ? 'room' : 'equipment';
      const key = target.roomId ? 'roomid' : 'equipmentid';
      const resource = (await this.db.query<{
        buildingid: number; name: string; location: string; status: string; certid: number | null; waiverrequired: boolean;
      }>(`SELECT buildingid,name,location,status,${table === 'equipment' ? 'certid,COALESCE(waiverrequired,false) AS waiverrequired' : 'NULL::int AS certid,false AS waiverrequired'}
          FROM ${table} WHERE ${key}=$1 FOR SHARE`,[target.roomId ?? target.equipmentId])).rows[0];
      if (!resource) throw new AppError(404,'NOT_FOUND','Access resource not found.');
      if (resource.status !== 'available') throw new AppError(409,'RESOURCE_UNAVAILABLE','This resource is unavailable.');
      buildingId = resource.buildingid;
      location = target.roomId ? `${resource.name} - ${resource.location}` : resource.name;
      if (resource.certid && !await this.eligibility.certification(userId,resource.certid,at))
        throw new AppError(403,'CERTIFICATION_REQUIRED','A current certification for this equipment is required.');
      if (resource.waiverrequired) await this.assertWaivers(userId, 'equipment');
    }
    if (buildingId !== undefined) {
      const building = (await this.db.query<{name: string; status: string}>(
        'SELECT name,status FROM building WHERE buildingid=$1 FOR SHARE',[buildingId])).rows[0];
      if (!building) throw new AppError(404,'NOT_FOUND','Building not found.');
      if (building.status !== 'available') throw new AppError(403,'RESOURCE_UNAVAILABLE','This building is unavailable.');
      location ??= building.name;
    }
    const sponsor = await new MinorSupervision(this.db,this.timeZone).requireSponsor(userId,buildingId);
    // Facility presence is independent of a room/equipment booking. A building
    // grant carries no reservation or resource permission; readers revalidate it
    // within five seconds just like resource grants.
    if (!target.roomId && !target.equipmentId) {
      return {
        reservationId: null, buildingId: buildingId!, location: location!,
        endsAt: new Date(at.getTime() + 5000), entitlement, sponsorId: sponsor?.id ?? null,
      };
    }
    // A class's room booking is held by whoever scheduled it, so it never opens the door for them;
    // during the class it admits the assigned instructor and the members actively registered for it
    // (cancelled and no-show registrations don't count). Every other booking admits only its holder.
    const reservation = (await this.db.query<{
      id: number; buildingId: number; buildingName: string; endsAt: Date; classId: number | null; classSponsorId: number | null;
    }>(`SELECT r.reservationid AS id,b.buildingid AS "buildingId",b.name AS "buildingName",
          r.endtime AT TIME ZONE 'UTC' AS "endsAt",c.id AS "classId",en.sponsor_id AS "classSponsorId"
        FROM reservation r LEFT JOIN equipment e USING(equipmentid) LEFT JOIN room USING(roomid)
        JOIN building b ON b.buildingid=COALESCE(e.buildingid,room.buildingid)
        LEFT JOIN app_training_class c ON c.reservation_id=r.reservationid
        LEFT JOIN app_training_enrollment en ON en.class_id=c.id AND en.user_id=$1 AND en.status IN ('enrolled','attended')
        WHERE r.status='confirmed'
          AND CASE WHEN c.id IS NULL THEN r.userid=$1
            ELSE c.status='scheduled' AND (c.instructor_id=$1 OR en.user_id IS NOT NULL) END
          AND r.starttime <= $2::timestamptz AT TIME ZONE 'UTC' AND r.endtime > $2::timestamptz AT TIME ZONE 'UTC'
          AND ($3::int IS NULL OR b.buildingid=$3)
          AND ($4::int IS NULL OR r.roomid=$4) AND ($5::int IS NULL OR r.equipmentid=$5)
          AND b.status='available' AND (e.equipmentid IS NULL OR e.status='available')
          AND (room.roomid IS NULL OR room.status='available')
        ORDER BY r.starttime,r.reservationid LIMIT 1 FOR SHARE OF r`,
      [userId,at,buildingId ?? null,target.roomId ?? null,target.equipmentId ?? null])).rows[0];
    if (!reservation) throw new AppError(403,'RESERVATION_REQUIRED','A current confirmed reservation is required for this access.');
    // A minor's class seat is tied to the sponsor who registered them with it, as a booking is.
    if (sponsor && (reservation.classId !== null
      ? reservation.classSponsorId !== sponsor.id
      : !(await this.db.query('SELECT reservation_id FROM app_minor_booking WHERE reservation_id=$1 AND adult_id=$2',[reservation.id,sponsor.id])).rowCount))
      throw new AppError(403,'SPONSOR_BOOKING_REQUIRED','Staff must link this booking to your current sponsoring adult.');
    return {
      reservationId: reservation.id, buildingId: reservation.buildingId,
      location: location ?? reservation.buildingName, endsAt: reservation.endsAt, entitlement, sponsorId:sponsor?.id ?? null,
    };
  }

  /**
   * A studio opens only for the member renting it now: a confirmed, paid rental whose days cover
   * today in the facility's time zone (ends_on is the first day after the rental). Account,
   * entitlement and policy checks have already run, as for a room. Studios are all in the main
   * building until studios carry their own building.
   */
  private async studioAccess(userId: number, studioId: number, entitlement: Awaited<ReturnType<AccessService['assertEntitlement']>>, at: Date) {
    const studio = (await this.db.query<{name: string; active: boolean}>(
      'SELECT name,active FROM app_studio WHERE id=$1 FOR SHARE',[studioId])).rows[0];
    if (!studio) throw new AppError(404,'NOT_FOUND','Access resource not found.');
    if (!studio.active) throw new AppError(409,'RESOURCE_UNAVAILABLE','This resource is unavailable.');
    const building = (await this.db.query<{status: string}>(
      'SELECT status FROM building WHERE buildingid=$1 FOR SHARE',[DEFAULT_BUILDING_ID])).rows[0];
    if (!building) throw new AppError(404,'NOT_FOUND','Building not found.');
    if (building.status !== 'available') throw new AppError(403,'RESOURCE_UNAVAILABLE','This building is unavailable.');
    const sponsor = await new MinorSupervision(this.db,this.timeZone).requireSponsor(userId,DEFAULT_BUILDING_ID);
    const rental = (await this.db.query<{id: number; endsAt: Date}>(`SELECT id,ends_on::timestamp AT TIME ZONE $3 AS "endsAt"
        FROM app_studio_rental WHERE studio_id=$1 AND userid=$2 AND status='confirmed' AND payment_status='paid'
          AND starts_on<=($4::timestamptz AT TIME ZONE $3)::date AND ends_on>($4::timestamptz AT TIME ZONE $3)::date
        ORDER BY starts_on,id LIMIT 1 FOR SHARE`,[studioId,userId,this.timeZone,at])).rows[0];
    if (!rental) throw new AppError(403,'STUDIO_RENTAL_REQUIRED','A current paid rental of this studio is required for this access.');
    // A minor's rental is tied to the sponsor who was present when it was booked, as a booking is.
    if (sponsor && !(await this.db.query('SELECT rental_id FROM app_minor_studio_booking WHERE rental_id=$1 AND adult_id=$2',[rental.id,sponsor.id])).rowCount)
      throw new AppError(403,'SPONSOR_BOOKING_REQUIRED','Staff must link this booking to your current sponsoring adult.');
    return {
      reservationId: null, buildingId: DEFAULT_BUILDING_ID, location: studio.name,
      endsAt: rental.endsAt, entitlement, sponsorId: sponsor?.id ?? null,
    };
  }
}
