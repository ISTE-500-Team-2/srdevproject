import { StaffModel } from '../models/StaffModel.js';
import { UserModel } from '../models/UserModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { enqueueNotification } from '../notifications/store.js';
import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, positiveId, reservationWindow } from '../domain.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import { ReservationModel } from '../models/ReservationModel.js';
import { AccessService } from './AccessService.js';

export class ReservationService {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}

  async create(
    userId: number,
    input: { equipmentId?: unknown; startTime?: unknown; endTime?: unknown; userId?: unknown },
  ) {
    const equipmentId = positiveId(input.equipmentId, 'Equipment');
    const { start, end } = reservationWindow(input.startTime, input.endTime);
    const targetId = input.userId == null ? userId : positiveId(input.userId, 'Member');
    if ((end.getTime()-start.getTime()) % 3_600_000 !== 0)
      throw new AppError(400,'HOURLY_DURATION_REQUIRED','Book a whole number of hours (1–24).');
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(userId);
      const actor = await new UserModel(db).findById(userId);
      if (!actor || actor.roles.includes('instructor'))
        throw new AppError(403,'INSTRUCTOR_BOOKING_FORBIDDEN','Instructor accounts cannot create reservations.');
      if (targetId !== userId && !actor.roles.some(role=>['staff','admin'].includes(role)))
        throw new AppError(403,'STAFF_REQUIRED','Only staff can book for another member.');
      if (!await new PermissionModel(db).allows(actor,'reservation','create',targetId))
        throw new AppError(403,'PERMISSION_REQUIRED','Reservation permission is required.');
      await access.assertActiveUser(targetId);
      // Lock the equipment row before checking the interval: concurrent requests serialize.
      const equipment = await new EquipmentModel(db).findForUpdate(equipmentId);
      if (!equipment)
        throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
      if (equipment.status !== 'available')
        throw new AppError(
          409,
          'EQUIPMENT_UNAVAILABLE',
          'This equipment is not available for reservations.',
        );
      await access.assertEntitlement(targetId, start, end);
      if (
        equipment.certId &&
        !(await access.eligibility.certification(targetId, equipment.certId, end))
      ) {
        throw new AppError(
          403,
          'CERTIFICATION_REQUIRED',
          `A current ${equipment.certification ?? 'equipment'} certification is required.`,
        );
      }
      const waivers = equipment.waiverRequired
        ? await access.assertWaivers(targetId)
        : [];
      const model = new ReservationModel(db);
      if (await model.overlaps(equipmentId, start, end))
        throw new AppError(
          409,
          'RESERVATION_CONFLICT',
          'That equipment is already reserved for part of this time.',
        );
      const reservation = await model.create({
        userId: targetId,
        equipmentId,
        waiverId: waivers[0]?.id ?? null,
        location: equipment.location,
        start,
        end,
      });
      await new StaffModel(db).audit(userId,targetId,'reservation.created','reservation',reservation.id,targetId===userId?'Member booking':'Staff booking on behalf of member',null,reservation);
      await enqueueNotification(db,{userId:targetId,kind:'reservation_created',dedupeKey:`reservation-created:${reservation.id}`,payload:{reservationId:reservation.id,resourceName:reservation.equipmentName,startsAt:start.toISOString(),endsAt:end.toISOString()}});
      return reservation;
    });
  }
}
