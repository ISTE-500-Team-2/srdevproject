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
    input: { equipmentId?: unknown; startTime?: unknown; endTime?: unknown },
  ) {
    const equipmentId = positiveId(input.equipmentId, 'Equipment');
    const { start, end } = reservationWindow(input.startTime, input.endTime);
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(userId);
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
      await access.assertEntitlement(userId, start, end);
      if (
        equipment.certId &&
        !(await access.eligibility.certification(userId, equipment.certId, end))
      ) {
        throw new AppError(
          403,
          'CERTIFICATION_REQUIRED',
          `A current ${equipment.certification ?? 'equipment'} certification is required.`,
        );
      }
      const waivers = equipment.waiverRequired
        ? await access.assertWaivers(userId)
        : [];
      const model = new ReservationModel(db);
      if (await model.overlaps(equipmentId, start, end))
        throw new AppError(
          409,
          'RESERVATION_CONFLICT',
          'That equipment is already reserved for part of this time.',
        );
      return model.create({
        userId,
        equipmentId,
        waiverId: waivers[0]?.id ?? null,
        location: equipment.location,
        start,
        end,
      });
    });
  }
}
