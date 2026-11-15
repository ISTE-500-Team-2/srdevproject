import { MinorSupervision } from "../minorSupervision.js";
import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { accessStatusCode, entitlementCode, waiverCode } from "../eligibility.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import type { EquipmentRecord } from "../models/EquipmentModel.js";
import type { PolicyScope } from "../staffDomain.js";

export interface AccessTarget {
  buildingId?: number;
  roomId?: number;
  equipmentId?: number;
}

export class AccessService {
  readonly eligibility: EligibilityModel;
  constructor(private db: Database, private timeZone: string) {
    this.eligibility = new EligibilityModel(db,timeZone);
  }

  async assertActiveUser(userId: number) {
    const user = (await this.db.query<{status: string; accessstatus: string}>(
      'SELECT status,accessstatus FROM "user" WHERE userid=$1 FOR SHARE',[userId])).rows[0];
    if (user?.status !== 'active')
      throw new AppError(403,'ACCOUNT_INACTIVE','This account does not currently have access.');
    if (accessStatusCode(user.accessstatus))
      throw new AppError(403,'ACCESS_BLOCKED','Facility access is suspended or revoked. Contact staff.');
  }

  async assertEntitlement(userId: number, start: Date, end = start) {
    const value = await this.eligibility.entitlement(userId,start,end);
    if (entitlementCode(value))
      throw new AppError(403,'MEMBERSHIP_REQUIRED','An active membership or valid day pass is required for this time.');
    return value;
  }

  async assertWaivers(userId: number, scope: PolicyScope = 'facility', through?: Date) {
    const waivers = await this.eligibility.waivers(userId, scope, through);
    const code = waiverCode(waivers);
    if (code === 'WAIVERS_NOT_CONFIGURED')
      throw new AppError(409,'WAIVERS_NOT_CONFIGURED',scope === 'equipment'
        ? 'Staff need to configure the required equipment waivers before this equipment can be used.'
        : 'Staff need to configure the required facility policies before access can be granted.');
    if (code === 'WAIVER_REQUIRED')
      throw new AppError(403,'WAIVER_REQUIRED',through
        ? `Sign all current required ${scope === 'equipment' ? 'equipment waivers' : 'facility policies'} first. They must remain valid through your reservation.`
        : `Sign all current required ${scope === 'equipment' ? 'equipment waivers' : 'facility policies'} first.`);
    return waivers;
  }

  async assertEquipmentWaivers(userId: number, through?: Date) {
    await this.assertWaivers(userId, 'facility', through);
    return this.assertWaivers(userId, 'equipment', through);
  }

  async assertEquipmentRequirements(userId: number, equipment: EquipmentRecord, through: Date) {
    if (equipment.certId && !await this.eligibility.certification(userId, equipment.certId, through))
      throw new AppError(403, 'CERTIFICATION_REQUIRED', `A current ${equipment.certification ?? 'equipment'} certification is required.`);
    return equipment.waiverRequired ? this.assertEquipmentWaivers(userId, through) : [];
  }

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
  async accessForTarget(userId: number, target: AccessTarget, at = new Date()) {
    await this.assertActiveUser(userId);
    const entitlement = await this.assertEntitlement(userId,at);
    await this.assertWaivers(userId);
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
    const reservation = (await this.db.query<{
      id: number; buildingId: number; buildingName: string; endsAt: Date;
    }>(`SELECT r.reservationid AS id,b.buildingid AS "buildingId",b.name AS "buildingName",
          r.endtime AT TIME ZONE 'UTC' AS "endsAt"
        FROM reservation r LEFT JOIN equipment e USING(equipmentid) LEFT JOIN room USING(roomid)
        JOIN building b ON b.buildingid=COALESCE(e.buildingid,room.buildingid)
        WHERE r.userid=$1 AND r.status='confirmed'
          AND r.starttime <= $2::timestamptz AT TIME ZONE 'UTC' AND r.endtime > $2::timestamptz AT TIME ZONE 'UTC'
          AND ($3::int IS NULL OR b.buildingid=$3)
          AND ($4::int IS NULL OR r.roomid=$4) AND ($5::int IS NULL OR r.equipmentid=$5)
          AND b.status='available' AND (e.equipmentid IS NULL OR e.status='available')
          AND (room.roomid IS NULL OR room.status='available')
        ORDER BY r.starttime,r.reservationid LIMIT 1 FOR SHARE OF r`,
      [userId,at,buildingId ?? null,target.roomId ?? null,target.equipmentId ?? null])).rows[0];
    if (!reservation) throw new AppError(403,'RESERVATION_REQUIRED','A current confirmed reservation is required for this access.');
    if (sponsor && !(await this.db.query('SELECT reservation_id FROM app_minor_booking WHERE reservation_id=$1 AND adult_id=$2',[reservation.id,sponsor.id])).rowCount)
      throw new AppError(403,'SPONSOR_BOOKING_REQUIRED','Staff must link this booking to your current sponsoring adult.');
    return {
      reservationId: reservation.id, buildingId: reservation.buildingId,
      location: location ?? reservation.buildingName, endsAt: reservation.endsAt, entitlement, sponsorId:sponsor?.id ?? null,
    };
  }
}
