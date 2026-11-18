// Validates and audits equipment changes; linked reservations and other records can block removal.

import type { Pool } from 'pg';
import { transaction, type Database } from '../db.js';
import { AppError, positiveId, textField, type UserView } from '../domain.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { UserModel } from '../models/UserModel.js';
import { AccessService } from './AccessService.js';
import { activeEquipmentGrants } from './EquipmentMaintenanceService.js';
import { MAX_BOOKING_CENTS, MAX_BOOKING_HOURS, MIN_CARD_PAYMENT_CENTS } from '../equipmentPricing.js';

/** Removed machines keep their history but are no longer part of the catalog. */
const active = 'NOT EXISTS(SELECT 1 FROM app_equipment_retirement r WHERE r.equipment_id=e.equipmentid)';
/** The highest hourly rate whose longest booking stays within the booking limit: $4,166.66. */
export const MAX_HOURLY_RATE_CENTS = Math.floor(MAX_BOOKING_CENTS / MAX_BOOKING_HOURS);
const dollars = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });

/** A rate booking can charge: free, or a card payment that works from one hour up to a full day. */
function assertBookableRate(rate: number | null) {
  if (rate === null)
    throw new AppError(400, 'INVALID_INPUT', 'Set an hourly rate, or 0 if the equipment is free to use.');
  const cents = Math.round(rate * 100);
  if (cents > 0 && cents < MIN_CARD_PAYMENT_CENTS)
    throw new AppError(400, 'INVALID_INPUT', `Card payments start at ${dollars(MIN_CARD_PAYMENT_CENTS)}. Use ${dollars(MIN_CARD_PAYMENT_CENTS)} an hour or more, or 0 if the equipment is free to use.`);
  if (cents > MAX_HOURLY_RATE_CENTS)
    throw new AppError(400, 'INVALID_INPUT', `Use ${dollars(MAX_HOURLY_RATE_CENTS)} an hour or less so a ${MAX_BOOKING_HOURS}-hour booking stays within the ${dollars(MAX_BOOKING_CENTS)} limit.`);
}

export function equipmentFields(input: Record<string, unknown>) {
  const name = textField(input.name, 'Name', 100);
  const category = textField(input.type, 'Category', 100);
  const location = textField(input.location, 'Location', 100);
  const image = textField(input.image ?? '', 'Image', 255, 0);
  if (image && !/^\/(?!\/)/.test(image) && !/^https:\/\//i.test(image))
    throw new AppError(400, 'INVALID_INPUT', 'Use an image path starting with / or an HTTPS URL.');
  const rate = input.rate === null ? null : input.rate;
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 99999999.99 || Math.abs(rate * 100 - Math.round(rate * 100)) > 0.000001))
    throw new AppError(400, 'INVALID_INPUT', 'Hourly rate must be a nonnegative amount with at most two decimal places.');
  const certId = input.certId === null ? null : positiveId(input.certId, 'Certification');
  if (typeof input.waiverRequired !== 'boolean') throw new AppError(400, 'INVALID_INPUT', 'Choose whether waivers are required.');
  return { name, category, location, image: image || null, rate, certId, waiverRequired: input.waiverRequired };
}

type Action = 'create' | 'update' | 'delete';

/** What keeps a machine in the catalog: live reader sessions, and bookings that haven't ended. */
export async function removalBlockers(db: Database, id: number) {
  const sessions = await activeEquipmentGrants(db, id);
  const bookings = (await db.query(`SELECT r.reservationid AS id,u.firstname || ' ' || u.lastname AS member,
      r.starttime AT TIME ZONE 'UTC' AS "startTime",r.endtime AT TIME ZONE 'UTC' AS "endTime"
    FROM reservation r LEFT JOIN "user" u ON u.userid=r.userid
    WHERE r.equipmentid=$1 AND r.status IN ('pending','confirmed') AND r.endtime>clock_timestamp() AT TIME ZONE 'UTC'
    ORDER BY r.starttime,r.reservationid LIMIT 20`, [id])).rows;
  return { sessions, bookings };
}

export class EquipmentCatalogService {
  constructor(private pool: Pool, private timeZone: string) {}

  /**
   * What the add/edit window offers: the categories of machines still in the catalog (one spelling
   * each) with their machines, and every certification with whether it is in effect and who holds it.
   */
  async options(user: UserView) {
    const [groups, certifications, waiver] = await Promise.all([
      // Each machine keeps its member-facing type (EquipmentModel: its category, else its name); the
      // group offers the most used spelling. Machines without a category form one group with no name.
      this.pool.query<{ name: string | null; machines: { id: number; name: string; image: string; type: string }[] }>(`
        SELECT NULLIF(mode() WITHIN GROUP (ORDER BY trim(e.category)),'') AS name,
          json_agg(json_build_object('id',e.equipmentid,'name',e.name,'image',COALESCE(e.imagepath,'/assets/3d-printer.webp'),'type',COALESCE(e.category,e.name))
            ORDER BY e.equipmentid) AS machines
        FROM equipment e WHERE ${active}
        GROUP BY lower(trim(COALESCE(e.category,''))) ORDER BY 1 NULLS LAST`),
      // Holders pass the same test booking uses (EligibilityModel.certification) and have active access.
      this.pool.query(`
        SELECT c.certid AS id,c.name,
          CASE WHEN c.enddate IS NOT NULL AND c.enddate<NOW() AT TIME ZONE 'UTC' THEN 'ended'
               WHEN c.effectivedate IS NOT NULL AND c.effectivedate>NOW() AT TIME ZONE 'UTC' THEN 'later'
               ELSE 'now' END AS state,
          to_char((c.effectivedate AT TIME ZONE 'UTC') AT TIME ZONE $1,'YYYY-MM-DD') AS "startsOn",
          to_char((c.enddate AT TIME ZONE 'UTC') AT TIME ZONE $1,'YYYY-MM-DD') AS "endedOn",
          (SELECT count(DISTINCT uc.userid)::int FROM user_certifications uc JOIN "user" u ON u.userid=uc.userid
            WHERE uc.certid=c.certid AND uc.status='active' AND u.accessstatus='active'
              AND (uc.renewaldate IS NULL OR uc.renewaldate>=NOW() AT TIME ZONE 'UTC')) AS holders
        FROM certifications c ORDER BY c.name`, [this.timeZone]),
      // A waiver-required booking checks the current facility and equipment policies and fails while
      // either scope has none (AccessService.assertEquipmentWaivers); same current versions as EligibilityModel.waivers.
      this.pool.query<{ ready: boolean }>(`WITH current_waivers AS (
          SELECT DISTINCT ON (name) policy_scope FROM waiver WHERE isactive=true AND required=true
            AND (effectivedate IS NULL OR effectivedate<=NOW() AT TIME ZONE 'UTC')
          ORDER BY name,effectivedate DESC NULLS LAST,waiverid DESC)
        SELECT COALESCE(bool_or(policy_scope='facility'),false) AND COALESCE(bool_or(policy_scope='equipment'),false) AS ready FROM current_waivers`),
    ]);
    return {
      canManage: user.roles.includes('admin'),
      categories: groups.rows.flatMap(group => group.name ? [group.name] : []),
      certifications: certifications.rows,
      groups: groups.rows,
      waiversPublished: waiver.rows[0]!.ready,
    };
  }

  /** Shown before removal so the administrator knows what to resolve first. */
  async blockers(id: number) {
    if (!(await this.pool.query(`SELECT 1 FROM equipment e WHERE e.equipmentid=$1
      AND NOT EXISTS(SELECT 1 FROM app_equipment_retirement r WHERE r.equipment_id=e.equipmentid)`, [id])).rows.length)
      throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
    return removalBlockers(this.pool, id);
  }

  async save(actorId: number, id: number | null, input: Record<string, unknown>) {
    const f = equipmentFields(input);
    return transaction(this.pool, async db => {
      const before = await this.authorize(db, actorId, id === null ? 'create' : 'update', id, input);
      // New and changed values must be bookable; an edit that leaves an older value alone still saves.
      const rateChanged = !before || (before.rate === null ? f.rate !== null : f.rate === null || Number(before.rate) !== f.rate);
      if (rateChanged) assertBookableRate(f.rate);
      if (f.certId !== null) {
        const cert = (await db.query<{ ended: boolean }>(`SELECT enddate IS NOT NULL AND enddate<NOW() AT TIME ZONE 'UTC' AS ended
          FROM certifications WHERE certid=$1`, [f.certId])).rows[0];
        if (!cert) throw new AppError(400, 'INVALID_INPUT', 'Choose an existing certification.');
        if (cert.ended && before?.certId !== f.certId)
          throw new AppError(400, 'INVALID_INPUT', 'That certification has ended, so no one could book this equipment. Choose one that is in effect.');
      }
      // A new or changed name or category is checked; an edit that keeps both leaves older data as it is.
      const categoryChanged = !before || before.type.trim() !== f.category;
      if (categoryChanged || before.name.trim() !== f.name) {
        // Saves into one category take turns, so two can't both pass the checks below.
        await db.query("SELECT pg_advisory_xact_lock(hashtext('arbor-equipment-category'),hashtext(lower($1)))", [f.category]);
        // One category, one spelling: "3d printer" joins the existing "3D printer".
        const spelling = categoryChanged ? (await db.query<{ name: string }>(`SELECT trim(e.category) AS name FROM equipment e
          WHERE lower(trim(e.category))=lower($1) AND e.equipmentid IS DISTINCT FROM $2 AND ${active}
          GROUP BY 1 ORDER BY count(*) DESC,1 LIMIT 1`, [f.category, id])).rows[0] : undefined;
        if (spelling) f.category = spelling.name;
        // Members pick a machine by name within its category, so two there can't share one.
        if ((await db.query(`SELECT 1 FROM equipment e
          WHERE lower(trim(e.name))=lower($1) AND lower(trim(e.category))=lower($2) AND e.equipmentid IS DISTINCT FROM $3 AND ${active}`,
          [f.name, f.category, id])).rows.length)
          throw new AppError(409, 'DUPLICATE_NAME', `Another ${f.category} is already called ${f.name}. Give this one a different name, like ${f.name} #2.`);
      }
      const values = [f.name, f.category, f.location, f.image, f.rate, f.certId, f.waiverRequired];
      const after = (await db.query<{ id: number }>(id === null
        ? `INSERT INTO equipment(name,category,location,imagepath,hourlyrate,certid,waiverrequired,status) VALUES($1,$2,$3,$4,$5,$6,$7,'available') RETURNING equipmentid AS id`
        : `UPDATE equipment SET name=$1,category=$2,location=$3,imagepath=$4,hourlyrate=$5,certid=$6,waiverrequired=$7,availability_revision=availability_revision+1 WHERE equipmentid=$8 RETURNING equipmentid AS id`,
        id === null ? values : [...values, id])).rows[0]!;
      await new StaffModel(db).audit(actorId, null, id === null ? 'equipment.created' : 'equipment.updated', 'equipment', after.id, 'Equipment catalog change', before, f);
      return after;
    });
  }

  /** Retires the machine: it leaves the catalog, its bookings, payments and service history stay. */
  /**
   * Check linked-record blockers inside the deletion transaction so removing equipment cannot
   * orphan live workflow data.
   */
  async remove(actorId: number, id: number, input: Record<string, unknown>) {
    return transaction(this.pool, async db => {
      const before = await this.authorize(db, actorId, 'delete', id, input);
      // Booking creation locks the equipment row too, so none can slip in after this check.
      const { sessions, bookings } = await removalBlockers(db, id);
      if (sessions.length)
        throw new AppError(409, 'EQUIPMENT_IN_USE', 'Wait for active reader sessions to end before removing equipment.');
      if (bookings.length)
        throw new AppError(409, 'UPCOMING_BOOKINGS', 'Move or cancel current and upcoming bookings before removing this equipment.');
      await db.query(`INSERT INTO app_equipment_retirement(equipment_id,reason) VALUES($1,'Removed by an administrator from the staff workspace')`, [id]);
      await db.query(`UPDATE equipment SET status='unavailable',availability_revision=availability_revision+1 WHERE equipmentid=$1`, [id]);
      await new StaffModel(db).audit(actorId, null, 'equipment.removed', 'equipment', id, 'Removed from catalog; history preserved', before, null);
      return { id };
    });
  }

  /** Administrator with the matching permission; existing rows are locked and revision-checked. */
  private async authorize(db: Database, actorId: number, action: Action, id: number | null, input: Record<string, unknown>) {
    await new AccessService(db, this.timeZone).assertActiveUser(actorId);
    const actor = await new UserModel(db, this.timeZone).findById(actorId);
    if (!actor?.roles.includes('admin') || !await new PermissionModel(db).allows(actor, 'equipment', action))
      throw new AppError(403, 'ADMIN_REQUIRED', 'Only an administrator can manage the equipment catalog.');
    if (id === null) return null;
    const before = await new EquipmentModel(db).findForUpdate(id);
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
    if (before.availabilityRevision !== positiveId(input.expectedRevision, 'Revision'))
      throw new AppError(409, 'STALE_RECORD', 'Equipment changed. Close this window and reload before trying again.');
    return before;
  }
}
