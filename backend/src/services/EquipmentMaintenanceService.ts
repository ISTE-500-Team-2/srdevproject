import type { Pool } from 'pg';
import { transaction, type Database } from '../db.js';
import { AppError, positiveId, textField, type UserView } from '../domain.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { StaffModel } from '../models/StaffModel.js';
import { UserModel } from '../models/UserModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { AccessService } from './AccessService.js';

export const maintenanceReasons: Record<string, string> = {
  repair: 'Repair', maintenance: 'Routine maintenance', safety: 'Safety concern', other: 'Other',
};
const outageColumns = `o.id,o.reason,o.staff_note AS "staffNote",o.expected_back::text AS "expectedBack",
  o.started_at AS "startedAt",o.ended_at AS "endedAt",o.return_note AS "returnNote",
  s.firstname || ' ' || s.lastname AS "startedBy",r.firstname || ' ' || r.lastname AS "endedBy"`;

export async function activeEquipmentGrants(db: Database, id: number) {
  // Every outstanding grant counts, even if its reader was disabled or went
  // offline since issuance. A later deny doesn't revoke a previously issued lease.
  return (await db.query(`SELECT d.reader_id AS "readerId",max(d.expires_at) AS "expiresAt",
    array_agg(DISTINCT u.firstname || ' ' || u.lastname) AS members
    FROM app_device_access_event d LEFT JOIN "user" u ON u.userid=d.user_id
    WHERE d.target_kind='equipment' AND d.target_id=$1 AND d.allowed AND d.expires_at>clock_timestamp()
    GROUP BY d.reader_id ORDER BY d.reader_id`, [id])).rows;
}

export class EquipmentMaintenanceService {
  constructor(private pool: Pool, private timeZone: string) {}

  async list() {
    const machines = await new EquipmentModel(this.pool).list();
    const outages = (await this.pool.query(`SELECT ${outageColumns},o.equipment_id AS "equipmentId"
      FROM app_equipment_outage o JOIN "user" s ON s.userid=o.started_by
      LEFT JOIN "user" r ON r.userid=o.ended_by WHERE o.ended_at IS NULL`)).rows;
    const grants = (await this.pool.query(`SELECT target_id AS id,count(DISTINCT reader_id)::int AS count
      FROM app_device_access_event WHERE target_kind='equipment' AND allowed AND expires_at>clock_timestamp() GROUP BY target_id`)).rows;
    return machines.map(machine => ({ ...machine, rate: machine.rate === null ? null : Number(machine.rate),
      activeReaderLeases: grants.find(g => g.id === machine.id)?.count ?? 0,
      outage: outages.find(o => o.equipmentId === machine.id) ?? null }));
  }

  async detail(id: number, user: UserView) {
    return transaction(this.pool, async db => {
      // One consistent snapshot for status, history, and capability hints.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const machine = (await new EquipmentModel(db).list()).find(e => e.id === id);
      if (!machine) throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
      const history = (await db.query(`SELECT ${outageColumns} FROM app_equipment_outage o
        JOIN "user" s ON s.userid=o.started_by LEFT JOIN "user" r ON r.userid=o.ended_by
        WHERE o.equipment_id=$1 ORDER BY o.started_at DESC,o.id DESC LIMIT 20`, [id])).rows;
      const permission = new PermissionModel(db);
      return { ...machine, rate: machine.rate === null ? null : Number(machine.rate),
        outage: history.find(o => !o.endedAt) ?? null, history,
        activeGrants: await activeEquipmentGrants(db, id), checkedAt: new Date().toISOString(), timeZone: this.timeZone,
        canManage: user.roles.includes('admin') && await permission.allows(user, 'equipment', 'update'),
        canReadBookings: await permission.allows(user, 'reservation', 'read'),
        canManageBookings: !user.roles.includes('instructor') && await permission.allows(user, 'reservation', 'update'),
      };
    });
  }

  async change(actorId: number, id: number, input: Record<string, unknown>, restore: boolean) {
    const revision = positiveId(input.expectedRevision, 'Revision');
    const note = textField(input.note ?? '', 'Staff note', 500, 0);
    const reason = typeof input.reason === 'string' ? input.reason : '';
    let expectedBack: string | null = null;
    if (!restore) {
      if (!Object.hasOwn(maintenanceReasons, reason)) throw new AppError(400, 'REASON_REQUIRED', 'Choose a reason for taking this equipment out of service.');
      if (input.stopped !== true) throw new AppError(400, 'CONFIRM_STOPPED', 'Confirm the equipment is physically stopped and ready for maintenance.');
      if (input.expectedBack != null && input.expectedBack !== '') {
        const date = input.expectedBack;
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < today)
          throw new AppError(400, 'INVALID_DATE', 'Estimated return must be a valid date today or later.');
        expectedBack = date;
      }
    }
    return transaction(this.pool, async db => {
      await new AccessService(db, this.timeZone).assertActiveUser(actorId);
      const actor = await new UserModel(db).findById(actorId);
      if (!actor?.roles.includes('admin') || !await new PermissionModel(db).allows(actor, 'equipment', 'update'))
        throw new AppError(403, 'ADMIN_REQUIRED', 'Only an administrator can change equipment availability.');
      // AccessService holds FOR SHARE until its issued grant commits. This lock
      // serializes outages with both reader decisions and new reservations.
      const before = await new EquipmentModel(db).findForUpdate(id);
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
      if (before.availabilityRevision !== revision) throw new AppError(409, 'STALE_RECORD', 'Equipment changed. Recheck its status before saving.');
      if (restore === (before.status === 'available')) throw new AppError(409, 'INVALID_STATUS', restore ? 'Equipment is already available.' : 'Equipment is already out of service.');
      if (!restore && (await activeEquipmentGrants(db, id)).length)
        throw new AppError(409, 'EQUIPMENT_IN_USE', 'An active reader session is still using this equipment. Recheck when the session ends or its reservation expires.');
      if (restore) {
        await db.query(`UPDATE app_equipment_outage SET ended_at=clock_timestamp(),ended_by=$2,return_note=$3 WHERE equipment_id=$1 AND ended_at IS NULL`, [id, actorId, note]);
      } else {
        await db.query(`INSERT INTO app_equipment_outage(equipment_id,reason,staff_note,expected_back,started_by) VALUES($1,$2,$3,$4,$5)`, [id, reason, note, expectedBack, actorId]);
      }
      const after = (await db.query(`UPDATE equipment SET status=$2,availability_revision=availability_revision+1 WHERE equipmentid=$1 RETURNING status,availability_revision AS "availabilityRevision"`, [id, restore ? 'available' : 'maintenance'])).rows[0];
      await new StaffModel(db).audit(actorId, null, restore ? 'equipment.returned_to_service' : 'equipment.taken_out_of_service', 'equipment', id,
        restore ? 'Returned to service' : maintenanceReasons[reason]!, before, { ...after, note, ...(restore ? {} : { reason, expectedBack }) });
      return after;
    });
  }
}
