import { StaffModel } from '../models/StaffModel.js';
import { UserModel } from '../models/UserModel.js';
import { PermissionModel } from '../models/PermissionModel.js';
import { enqueueNotification } from '../notifications/store.js';
import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, positiveId, reservationWindow } from '../domain.js';
import { EquipmentModel } from '../models/EquipmentModel.js';
import {
  ReservationModel,
  RESERVATION_COOLDOWN_MINUTES,
} from '../models/ReservationModel.js';
import { RoomModel } from '../models/RoomModel.js';
import { AccessService } from './AccessService.js';

export class ReservationService {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}

  async create(
    userId: number,
    input: {
      equipmentId?: unknown;
      roomId?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      userId?: unknown;
    },
  ) {
    const hasEquipment =
      input.equipmentId !== undefined && input.equipmentId !== null;
    const hasRoom = input.roomId !== undefined && input.roomId !== null;
    if (hasEquipment === hasRoom)
      throw new AppError(
        400,
        'INVALID_INPUT',
        'Choose exactly one equipment item or room.',
      );

    const equipmentId = hasEquipment
      ? positiveId(input.equipmentId, 'Equipment')
      : null;
    const roomId = hasRoom ? positiveId(input.roomId, 'Room') : null;
    const { start, end } = reservationWindow(input.startTime, input.endTime);
    const targetId =
      input.userId == null ? userId : positiveId(input.userId, 'Member');

    if ((end.getTime() - start.getTime()) % 3_600_000 !== 0)
      throw new AppError(
        400,
        'HOURLY_DURATION_REQUIRED',
        'Book a whole number of hours (1-24).',
      );

    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(userId);

      const actor = await new UserModel(db).findById(userId);
      if (!actor || actor.roles.includes('instructor'))
        throw new AppError(
          403,
          'INSTRUCTOR_BOOKING_FORBIDDEN',
          'Instructor accounts cannot create reservations.',
        );
      if (
        targetId !== userId &&
        !actor.roles.some((role) => ['staff', 'admin'].includes(role))
      )
        throw new AppError(
          403,
          'STAFF_REQUIRED',
          'Only staff can book for another member.',
        );
      if (
        !(await new PermissionModel(db).allows(
          actor,
          'reservation',
          'create',
          targetId,
        ))
      )
        throw new AppError(
          403,
          'PERMISSION_REQUIRED',
          'Reservation permission is required.',
        );

      if (targetId !== userId) await access.assertActiveUser(targetId);
      await access.assertEntitlement(targetId, start, end);

      const model = new ReservationModel(db);
      let waiverId: number | null = null;
      let location: string;
      let resourceName: string;

      if (equipmentId) {
        const equipment = await new EquipmentModel(db).findForUpdate(
          equipmentId,
        );
        if (!equipment)
          throw new AppError(404, 'NOT_FOUND', 'Equipment not found.');
        if (equipment.status !== 'available')
          throw new AppError(
            409,
            'EQUIPMENT_UNAVAILABLE',
            'This equipment is not available for reservations.',
          );
        if (
          equipment.certId &&
          !(await access.eligibility.certification(
            targetId,
            equipment.certId,
            end,
          ))
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
        waiverId = waivers[0]?.id ?? null;
        location = equipment.location;
        resourceName = equipment.name;

        if (await model.overlaps(equipmentId, start, end))
          throw new AppError(
            409,
            'RESERVATION_CONFLICT',
            'That equipment is already reserved for part of this time.',
          );
        if (await model.equipmentCooldown(equipmentId, start, end))
          throw new AppError(
            409,
            'RESERVATION_COOLDOWN',
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between reservations for the same equipment, including other members' bookings.`,
          );
      } else {
        const room = await new RoomModel(db).findForUpdate(roomId!);
        if (!room) throw new AppError(404, 'NOT_FOUND', 'Room not found.');
        if (room.status !== 'available')
          throw new AppError(
            409,
            'ROOM_UNAVAILABLE',
            'This room is not available for reservations.',
          );

        location = room.location;
        resourceName = room.name;

        if (await model.roomOverlaps(room.id, start, end))
          throw new AppError(
            409,
            'RESERVATION_CONFLICT',
            'That room is already reserved for part of this time.',
          );
        if (await model.roomCooldown(targetId, room.id, start, end))
          throw new AppError(
            409,
            'RESERVATION_COOLDOWN',
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between your reservations for the same room.`,
          );
      }

      const reservation = await model.create({
        userId: targetId,
        equipmentId: equipmentId ?? undefined,
        roomId: roomId ?? undefined,
        waiverId,
        location,
        start,
        end,
      });

      await new StaffModel(db).audit(
        userId,
        targetId,
        'reservation.created',
        'reservation',
        reservation.id,
        targetId === userId
          ? 'Member booking'
          : 'Staff booking on behalf of member',
        null,
        reservation,
      );
      await enqueueNotification(db, {
        userId: targetId,
        kind: 'reservation_created',
        dedupeKey: `reservation-created:${reservation.id}`,
        payload: {
          reservationId: reservation.id,
          resourceName,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
        },
      });
      return reservation;
    });
  }
}
