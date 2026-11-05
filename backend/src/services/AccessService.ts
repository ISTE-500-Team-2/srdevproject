import { MinorSupervision } from "../minorSupervision.js";
import type { Database } from "../db.js";
import { AppError } from "../domain.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import type { EquipmentRecord } from "../models/EquipmentModel.js";

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
    if (user.accessstatus !== 'active')
      throw new AppError(403,'ACCESS_BLOCKED','Facility access is suspended or revoked. Contact staff.');
  }

  async assertEntitlement(userId: number, start: Date, end = start) {
    const value = await this.eligibility.entitlement(userId,start,end);
    if (!value.membership && !value.dayPass)
      throw new AppError(403,'MEMBERSHIP_REQUIRED','An active membership or valid day pass is required for this time.');
    return value;
  }

  async assertWaivers(userId: number, through?: Date) {
    const waivers = await this.eligibility.waivers(userId, through);
    if (!waivers.length)
      throw new AppError(409,'WAIVERS_NOT_CONFIGURED','Staff need to configure the required policies before access can be granted.');
    if (waivers.some(w => !w.signed))
      throw new AppError(403,'WAIVER_REQUIRED',through
        ? 'Sign all current required policies and waivers first. They must remain valid through your reservation.'
        : 'Sign all current required policies and waivers first.');
    return waivers;
  }

  async assertEquipmentRequirements(userId: number, equipment: EquipmentRecord, through: Date) {
    if (equipment.certId && !await this.eligibility.certification(userId, equipment.certId, through))
      throw new AppError(403, 'CERTIFICATION_REQUIRED', `A current ${equipment.certification ?? 'equipment'} certification is required.`);
    return equipment.waiverRequired ? this.assertWaivers(userId, through) : [];
  }

  // The caller keeps the decision and check-in in one transaction.
  async reservationForAccess(userId: number, target: AccessTarget, at = new Date()) {
    await this.assertActiveUser(userId);
    const entitlement = await this.assertEntitlement(userId,at);
    await this.assertWaivers(userId);
    let buildingId = target.buildingId;
    let location: string | undefined;
    if (target.roomId || target.equipmentId) {
      const table = target.roomId ? 'room' : 'equipment';
      const key = target.roomId ? 'roomid' : 'equipmentid';
      const resource = (await this.db.query<{
        buildingid: number; name: string; location: string; status: string; certid: number | null;
      }>(`SELECT buildingid,name,location,status,${table === 'equipment' ? 'certid' : 'NULL::int AS certid'}
          FROM ${table} WHERE ${key}=$1 FOR SHARE`,[target.roomId ?? target.equipmentId])).rows[0];
      if (!resource) throw new AppError(404,'NOT_FOUND','Access resource not found.');
      if (resource.status !== 'available') throw new AppError(409,'RESOURCE_UNAVAILABLE','This resource is unavailable.');
      buildingId = resource.buildingid;
      location = target.roomId ? `${resource.name} - ${resource.location}` : resource.name;
      if (resource.certid && !await this.eligibility.certification(userId,resource.certid,at))
        throw new AppError(403,'CERTIFICATION_REQUIRED','A current certification for this equipment is required.');
    }
    if (buildingId !== undefined) {
      const building = (await this.db.query<{name: string; status: string}>(
        'SELECT name,status FROM building WHERE buildingid=$1 FOR SHARE',[buildingId])).rows[0];
      if (!building) throw new AppError(404,'NOT_FOUND','Building not found.');
      if (building.status !== 'available') throw new AppError(403,'RESOURCE_UNAVAILABLE','This building is unavailable.');
      location ??= building.name;
    }
    const sponsor = await new MinorSupervision(this.db,this.timeZone).requireSponsor(userId,buildingId);
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
