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

  async update(
    actorId: number,
    reservationId: number,
    input: {
      equipmentId?: unknown;
      roomId?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      userId?: unknown;
      expectedRevision?: unknown;
    },
  ) {
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(actorId);

      const actor = await new UserModel(db).findById(actorId);
      if (!actor || actor.roles.includes('instructor'))
        throw new AppError(
          403,
          'INSTRUCTOR_BOOKING_FORBIDDEN',
          'Instructor accounts cannot create reservations.',
        );
      if (!actor.roles.some((role) => ['staff', 'admin'].includes(role)))
        throw new AppError(
          403,
          'STAFF_REQUIRED',
          'Only staff can modify another member reservation.',
        );

      const model = new ReservationModel(db, this.timeZone);
      const before = await model.find(reservationId, true);
      if (!before)
        throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
      if (!['confirmed', 'pending'].includes(before.status))
        throw new AppError(
          409,
          'INVALID_STATUS',
          'Only active reservations can be modified.',
        );
      const expectedRevision = positiveId(input.expectedRevision, 'revision');
      if (before.revision !== expectedRevision)
        throw new AppError(
          409,
          'STALE_RECORD',
          'This reservation changed. Refresh it before saving.',
        );

      const targetId =
        input.userId == null ? before.userId : positiveId(input.userId, 'Member');
      if (
        !(await new PermissionModel(db).allows(
          actor,
          'reservation',
          'update',
          targetId,
        ))
      )
        throw new AppError(
          403,
          'PERMISSION_REQUIRED',
          'Reservation update permission is required.',
        );

      const equipmentId =
        input.equipmentId === undefined
          ? before.equipmentId
          : input.equipmentId === null
            ? null
            : positiveId(input.equipmentId, 'Equipment');
      const roomId =
        input.roomId === undefined
          ? before.roomId
          : input.roomId === null
            ? null
            : positiveId(input.roomId, 'Room');
      if (!!equipmentId === !!roomId)
        throw new AppError(
          400,
          'INVALID_INPUT',
          'Choose exactly one equipment item or room.',
        );

      const { start, end } = reservationWindow(
        input.startTime ?? new Date(before.startTime).toISOString(),
        input.endTime ?? new Date(before.endTime).toISOString(),
      );
      if ((end.getTime() - start.getTime()) % 3_600_000 !== 0)
        throw new AppError(
          400,
          'HOURLY_DURATION_REQUIRED',
          'Book a whole number of hours (1-24).',
        );

      await access.assertActiveUser(targetId);
      await access.assertEntitlement(targetId, start, end);

      let waiverId: number | null = null;
      let location: string;
      let resourceName: string;

      if (equipmentId) {
        const equipment = await new EquipmentModel(db).findForUpdate(equipmentId);
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
          !(await access.eligibility.certification(targetId, equipment.certId, end))
        )
          throw new AppError(
            403,
            'CERTIFICATION_REQUIRED',
            `A current ${equipment.certification ?? 'equipment'} certification is required.`,
          );
        const waivers = equipment.waiverRequired
          ? await access.assertWaivers(targetId)
          : [];
        waiverId = waivers[0]?.id ?? null;
        location = equipment.location;
        resourceName = equipment.name;
        if (await model.overlaps(equipmentId, start, end, reservationId))
          throw new AppError(
            409,
            'RESERVATION_CONFLICT',
            'That equipment is already reserved for part of this time.',
          );
        if (await model.equipmentCooldown(equipmentId, start, end, reservationId))
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
        if (await model.roomOverlaps(room.id, start, end, reservationId))
          throw new AppError(
            409,
            'RESERVATION_CONFLICT',
            'That room is already reserved for part of this time.',
          );
        if (await model.roomCooldown(targetId, room.id, start, end, reservationId))
          throw new AppError(
            409,
            'RESERVATION_COOLDOWN',
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between your reservations for the same room.`,
          );
      }

      const reservation = await model.update(reservationId, {
        userId: targetId,
        equipmentId: equipmentId ?? undefined,
        roomId: roomId ?? undefined,
        waiverId,
        location,
        start,
        end,
      });
      if (!reservation)
        throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
      await new StaffModel(db).audit(
        actorId,
        targetId,
        'reservation.override.updated',
        'reservation',
        reservation.id,
        'Staff reservation override',
        before,
        reservation,
      );
      await enqueueNotification(db, {
        userId: targetId,
        kind: 'reservation_updated',
        dedupeKey: `reservation-updated:${reservation.id}:${reservation.revision}`,
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

  async cancelAny(actorId: number, reservationId: number) {
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(actorId);
      const actor = await new UserModel(db).findById(actorId);
      if (!actor || actor.roles.includes('instructor'))
        throw new AppError(
          403,
          'INSTRUCTOR_BOOKING_FORBIDDEN',
          'Instructor accounts cannot create reservations.',
        );
      if (!actor.roles.some((role) => ['staff', 'admin'].includes(role)))
        throw new AppError(
          403,
          'STAFF_REQUIRED',
          'Only staff can cancel another member reservation.',
        );

      const model = new ReservationModel(db);
      const before = await model.find(reservationId, true);
      if (!before)
        throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
      if (
        !(await new PermissionModel(db).allows(
          actor,
          'reservation',
          'update',
          before.userId,
        ))
      )
        throw new AppError(
          403,
          'PERMISSION_REQUIRED',
          'Reservation update permission is required.',
        );
      const result = await model.cancelAny(reservationId);
      if (!result)
        throw new AppError(
          409,
          'INVALID_STATUS',
          'Only active reservations can be cancelled.',
        );
      await new StaffModel(db).audit(
        actorId,
        before.userId,
        'reservation.override.cancelled',
        'reservation',
        result.id,
        'Staff reservation override',
        before,
        result,
      );
      await enqueueNotification(db, {
        userId: before.userId,
        kind: 'reservation_cancelled',
        dedupeKey: `reservation-cancelled:${result.id}`,
        payload: {
          reservationId: result.id,
          resourceName: result.equipmentName,
          startsAt: new Date(result.startTime).toISOString(),
          endsAt: new Date(result.endTime).toISOString(),
        },
      });
      return result;
    });
  }
}
