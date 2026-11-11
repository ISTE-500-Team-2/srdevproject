import type { Pool } from 'pg';
import { transaction, type Database } from '../db.js';
import { AppError, positiveId, textField, type UserView } from '../domain.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { UserModel } from '../models/UserModel.js';
import { AccessService } from './AccessService.js';
import { activeEquipmentGrants } from './EquipmentMaintenanceService.js';

export function equipmentFields(input: Record<string, unknown>) {
  const name = textField(input.name, 'Name', 100);
  const category = textField(input.type, 'Category', 100);
  const location = textField(input.location, 'Location', 100);
  const image = textField(input.image ?? '', 'Image', 255, 0);
  if (image && !/^\/(?!\/)/.test(image) && !/^https:\/\//i.test(image))
    throw new AppError(400, 'INVALID_INPUT', 'Use an image path starting with / or an HTTPS URL.');
  const rate = input.rate === null ? null : input.rate;
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 99999999.99 || Math.abs(rate * 100 - Math.round(rate * 100)) > 0.000001))
    throw new AppError(400, 'INVALID_INPUT', 'Hourly rate must be a nonnegative amount with at most two decimal places, or blank.');
  const certId = input.certId === null ? null : positiveId(input.certId, 'Certification');
  if (typeof input.waiverRequired !== 'boolean') throw new AppError(400, 'INVALID_INPUT', 'Choose whether waivers are required.');
  return { name, category, location, image: image || null, rate, certId, waiverRequired: input.waiverRequired };
}

type Action = 'create' | 'update' | 'delete';

export class EquipmentCatalogService {
  constructor(private pool: Pool, private timeZone: string) {}

  /** What the add/edit window offers. Categories are the ones already in use. */
  async options(user: UserView) {
    return {
      canManage: user.roles.includes('admin'),
      categories: (await this.pool.query<{ name: string }>(`SELECT DISTINCT trim(category) AS name FROM equipment
        WHERE category IS NOT NULL AND trim(category) <> '' ORDER BY name`)).rows.map(row => row.name),
      certifications: (await this.pool.query('SELECT certid AS id,name FROM certifications ORDER BY name')).rows,
    };
  }

  async save(actorId: number, id: number | null, input: Record<string, unknown>) {
    const f = equipmentFields(input);
    return transaction(this.pool, async db => {
      const before = await this.authorize(db, actorId, id === null ? 'create' : 'update', id, input);
      if (f.certId !== null && !(await db.query('SELECT 1 FROM certifications WHERE certid=$1', [f.certId])).rows.length)
        throw new AppError(400, 'INVALID_INPUT', 'Choose an existing certification.');
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
  async remove(actorId: number, id: number, input: Record<string, unknown>) {
    return transaction(this.pool, async db => {
      const before = await this.authorize(db, actorId, 'delete', id, input);
      if ((await activeEquipmentGrants(db, id)).length)
        throw new AppError(409, 'EQUIPMENT_IN_USE', 'Wait for active reader sessions to end before removing equipment.');
      // Booking creation locks the equipment row too, so none can slip in after this check.
      const bookings = await db.query(`SELECT 1 FROM reservation WHERE equipmentid=$1 AND status IN ('pending','confirmed')
        AND endtime>clock_timestamp() AT TIME ZONE 'UTC' LIMIT 1`, [id]);
      if (bookings.rows.length)
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
