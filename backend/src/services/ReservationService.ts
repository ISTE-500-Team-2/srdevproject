import { randomUUID } from "node:crypto";
import { EquipmentBilling } from "../billing/equipment.js";
import { StudioStripe } from "../studios/stripe.js";
import { MinorSupervision } from "../minorSupervision.js";
import { StaffModel } from "../models/StaffModel.js";
import { UserModel } from "../models/UserModel.js";
import { PermissionModel } from "../models/PermissionModel.js";
import { enqueueNotification } from "../notifications/store.js";
import type { Pool } from "pg";
import { transaction } from "../db.js";
import { AppError, positiveId, reservationWindow } from "../domain.js";
import { EquipmentModel } from "../models/EquipmentModel.js";
import {
  ReservationModel,
  RESERVATION_COOLDOWN_MINUTES,
} from "../models/ReservationModel.js";
import { RoomModel } from "../models/RoomModel.js";
import { AccessService } from "./AccessService.js";

export class ReservationService {
  constructor(
    private pool: Pool,
    private timeZone: string,
    private stripe?: StudioStripe,
  ) {}

  async create(
    userId: number,
    input: {
      equipmentId?: unknown;
      roomId?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      userId?: unknown;
      requestKey?: unknown;
      amountCents?: unknown;
    },
  ) {
    const hasEquipment =
      input.equipmentId !== undefined && input.equipmentId !== null;
    const hasRoom = input.roomId !== undefined && input.roomId !== null;
    if (hasEquipment === hasRoom)
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Choose exactly one equipment item or room.",
      );

    const equipmentId = hasEquipment
      ? positiveId(input.equipmentId, "Equipment")
      : null;
    const roomId = hasRoom ? positiveId(input.roomId, "Room") : null;
    const { start, end } = reservationWindow(input.startTime, input.endTime);
    const targetId =
      input.userId == null ? userId : positiveId(input.userId, "Member");

    if ((end.getTime() - start.getTime()) % 3_600_000 !== 0)
      throw new AppError(
        400,
        "HOURLY_DURATION_REQUIRED",
        "Book a whole number of hours (1-24).",
      );

    const requestKey = input.requestKey ?? randomUUID();
    if (typeof requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey))
      throw new AppError(400, 'INVALID_INPUT', 'Invalid reservation request key.');
    const billing = new EquipmentBilling(this.pool, this.stripe, this.timeZone);
    if (equipmentId) await billing.reconcile(userId);
    const created = await transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(userId);

      const actor = await new UserModel(db, this.timeZone).findById(userId);
      if (!actor || actor.roles.includes("instructor"))
        throw new AppError(
          403,
          "INSTRUCTOR_BOOKING_FORBIDDEN",
          "Instructor accounts cannot create reservations.",
        );
      if (
        targetId !== userId &&
        !actor.roles.some((role) => ["staff", "admin"].includes(role))
      )
        throw new AppError(
          403,
          "STAFF_REQUIRED",
          "Only staff can book for another member.",
        );
      if (
        !(await new PermissionModel(db).allows(
          actor,
          "reservation",
          "create",
          targetId,
        ))
      )
        throw new AppError(
          403,
          "PERMISSION_REQUIRED",
          "Reservation permission is required.",
        );

      await db.query("SELECT pg_advisory_xact_lock(hashtext('equipment-checkout'),$1)", [userId]);
      const prior = (await db.query(`SELECT r.reservationid,r.userid,r.equipmentid,
        r.starttime AT TIME ZONE 'UTC' AS start,r.endtime AT TIME ZONE 'UTC' AS end
        FROM app_equipment_checkout c JOIN reservation r ON r.reservationid=c.reservation_id
        WHERE c.payer_id=$1 AND c.request_key=$2`, [userId, requestKey])).rows[0];
      if (prior) {
        if (prior.userid !== targetId || prior.equipmentid !== equipmentId ||
          new Date(prior.start).getTime() !== start.getTime() || new Date(prior.end).getTime() !== end.getTime())
          throw new AppError(409, 'KEY_REUSED', 'Start a new checkout after changing reservation details.');
        return new ReservationModel(db).find(prior.reservationid);
      }
      if (targetId !== userId) await access.assertActiveUser(targetId);
      await access.assertEntitlement(targetId, start, end);
      // Take the final exclusive resource lock directly; upgrading SHARE later
      // can deadlock simultaneous reservations before conflict detection.
      const familyBuilding=(await db.query(`SELECT buildingid FROM ${equipmentId ? 'equipment' : 'room'} WHERE ${equipmentId ? 'equipmentid' : 'roomid'}=$1 FOR UPDATE`,[equipmentId ?? roomId])).rows[0];
      await new MinorSupervision(db,this.timeZone).requireSponsor(targetId,familyBuilding?.buildingid);

      const model = new ReservationModel(db);
      let waiverId: number | null = null;
      let location: string;
      let resourceName: string;
      let hourlyCents = 0;
      let amountCents = 0;
      const hours = (end.getTime() - start.getTime()) / 3_600_000;

      if (equipmentId) {
        const equipment = await new EquipmentModel(db).findForUpdate(
          equipmentId,
        );
        if (!equipment)
          throw new AppError(404, "NOT_FOUND", "Equipment not found.");
        if (equipment.status !== "available")
          throw new AppError(
            409,
            "EQUIPMENT_UNAVAILABLE",
            "This equipment is not available for reservations.",
          );
        const waivers = await access.assertEquipmentRequirements(targetId, equipment, end);
        waiverId = waivers[0]?.id ?? null;
        location = equipment.location;
        resourceName = equipment.name;
        if (equipment.rate === null)
          throw new AppError(409, 'RATE_NOT_SET', 'The hourly rate has not been set. Please contact staff.');
        hourlyCents = Math.round(Number(equipment.rate) * 100);
        amountCents = hourlyCents * hours;
        if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 99_999_999 || amountCents > 0 && amountCents < 50)
          throw new AppError(409, 'INVALID_RATE', 'This rate cannot be paid online. Please contact staff.');
        if (input.amountCents !== undefined && input.amountCents !== amountCents)
          throw new AppError(409, 'PRICE_CHANGED', 'The equipment rate changed. Review the updated total and try again.');
        if (amountCents > 0) {
          billing.provider();
          if (start.getTime() < Date.now() + 30 * 60_000)
            throw new AppError(400, 'PAYMENT_TIME_REQUIRED', 'Choose a start at least 30 minutes away to allow time for payment.');
        }

        if (await model.overlaps(equipmentId, start, end))
          throw new AppError(
            409,
            "RESERVATION_CONFLICT",
            "That equipment is already reserved for part of this time.",
          );
        if (await model.equipmentCooldown(equipmentId, start, end))
          throw new AppError(
            409,
            "RESERVATION_COOLDOWN",
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between reservations for the same equipment, including other members' bookings.`,
          );
      } else {
        const room = await new RoomModel(db).findForUpdate(roomId!);
        if (!room) throw new AppError(404, "NOT_FOUND", "Room not found.");
        if (room.status !== "available")
          throw new AppError(
            409,
            "ROOM_UNAVAILABLE",
            "This room is not available for reservations.",
          );

        location = room.location;
        resourceName = room.name;

        if (await model.roomOverlaps(room.id, start, end))
          throw new AppError(
            409,
            "RESERVATION_CONFLICT",
            "That room is already reserved for part of this time.",
          );
        if (await model.roomCooldown(targetId, room.id, start, end))
          throw new AppError(
            409,
            "RESERVATION_COOLDOWN",
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
        status: amountCents > 0 ? 'pending' : 'confirmed',
      });
      if (amountCents > 0) await db.query(`INSERT INTO app_equipment_checkout
        (reservation_id,payer_id,request_key,hourly_cents,hours,amount_cents,equipment_name) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [reservation.id, userId, requestKey, hourlyCents, hours, amountCents, resourceName]);

      await new MinorSupervision(db,this.timeZone).recordBooking(targetId,reservation.id);
      await new StaffModel(db).audit(
        userId,
        targetId,
        "reservation.created",
        "reservation",
        reservation.id,
        targetId === userId
          ? "Member booking"
          : "Staff booking on behalf of member",
        null,
        reservation,
      );
      if (!amountCents) await enqueueNotification(db, {
        userId: targetId,
        kind: "reservation_created",
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
    if (!created) throw new AppError(404, 'NOT_FOUND', 'Reservation not found.');
    if (equipmentId && (await this.pool.query('SELECT 1 FROM app_equipment_checkout WHERE reservation_id=$1', [created.id])).rowCount)
      return billing.checkout(userId, created.id);
    return created;
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
    maintenance?: { sourceEquipmentId: number; preview?: boolean; expectedRate?: unknown },
  ) {
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(actorId);

      const actor = await new UserModel(db, this.timeZone).findById(actorId);
      if (!actor || actor.roles.includes("instructor"))
        throw new AppError(
          403,
          "INSTRUCTOR_BOOKING_FORBIDDEN",
          "Instructor accounts cannot create reservations.",
        );
      if (!actor.roles.some((role) => ["staff", "admin"].includes(role)))
        throw new AppError(
          403,
          "STAFF_REQUIRED",
          "Only staff can modify another member reservation.",
        );

      const model = new ReservationModel(db, this.timeZone);
      const before = await model.find(reservationId, true);
      if (!before)
        throw new AppError(404, "NOT_FOUND", "Reservation not found.");
      if (!["confirmed", "pending"].includes(before.status))
        throw new AppError(
          409,
          "INVALID_STATUS",
          "Only active reservations can be modified.",
        );
      if (
        (
          await db.query(
            "SELECT id FROM app_training_class WHERE reservation_id=$1",
            [reservationId],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          "CLASS_WORKFLOW_REQUIRED",
          "Cancel and reschedule this training through Classes to preserve enrollment records.",
        );
      if ((await db.query('SELECT 1 FROM app_equipment_checkout WHERE reservation_id=$1', [reservationId])).rowCount)
        throw new AppError(409, 'PAYMENT_WORKFLOW_REQUIRED', 'Contact staff to reconcile payment before changing a paid reservation.');
      const expectedRevision = positiveId(input.expectedRevision, "revision");
      if (before.revision !== expectedRevision)
        throw new AppError(
          409,
          "STALE_RECORD",
          "This reservation changed. Refresh it before saving.",
        );

      if (maintenance && (before.equipmentId !== maintenance.sourceEquipmentId || before.equipmentId === input.equipmentId))
        throw new AppError(409, "STALE_RECORD", "Choose a different machine for this equipment's reservation.");

      const targetId =
        input.userId == null
          ? before.userId
          : positiveId(input.userId, "Member");
      if (
        !(await new PermissionModel(db).allows(
          actor,
          "reservation",
          "update",
          targetId,
        ))
      )
        throw new AppError(
          403,
          "PERMISSION_REQUIRED",
          "Reservation update permission is required.",
        );

      const equipmentId =
        input.equipmentId === undefined
          ? before.equipmentId
          : input.equipmentId === null
            ? null
            : positiveId(input.equipmentId, "Equipment");
      const roomId =
        input.roomId === undefined
          ? before.roomId
          : input.roomId === null
            ? null
            : positiveId(input.roomId, "Room");
      if (!!equipmentId === !!roomId)
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Choose exactly one equipment item or room.",
        );

      const { start, end } = reservationWindow(
        input.startTime ?? new Date(before.startTime).toISOString(),
        input.endTime ?? new Date(before.endTime).toISOString(),
      );
      if ((end.getTime() - start.getTime()) % 3_600_000 !== 0)
        throw new AppError(
          400,
          "HOURLY_DURATION_REQUIRED",
          "Book a whole number of hours (1-24).",
        );

      await access.assertActiveUser(targetId);
      await access.assertEntitlement(targetId, start, end);
      // Take the final exclusive resource lock directly; upgrading SHARE later
      // can deadlock simultaneous reservations before conflict detection.
      const familyBuilding=(await db.query(`SELECT buildingid FROM ${equipmentId ? 'equipment' : 'room'} WHERE ${equipmentId ? 'equipmentid' : 'roomid'}=$1 FOR UPDATE`,[equipmentId ?? roomId])).rows[0];
      // Staff moving someone else's booking (including maintenance reassignment) keeps its
      // existing sponsor link; the sponsor need not be in the building at edit time.
      const keepSponsorLink = targetId !== actorId && targetId === before.userId;
      if (!keepSponsorLink) await new MinorSupervision(db,this.timeZone).requireSponsor(targetId,familyBuilding?.buildingid);

      let waiverId: number | null = null;
      let location: string;
      let resourceName: string;

      if (equipmentId) {
        const equipment = await new EquipmentModel(db).findForUpdate(
          equipmentId,
        );
        if (!equipment)
          throw new AppError(404, "NOT_FOUND", "Equipment not found.");
        if (equipment.status !== "available")
          throw new AppError(
            409,
            "EQUIPMENT_UNAVAILABLE",
            "This equipment is not available for reservations.",
          );
        const waivers = await access.assertEquipmentRequirements(targetId, equipment, end);
        waiverId = waivers[0]?.id ?? null;
        location = equipment.location;
        resourceName = equipment.name;
        if (await model.overlaps(equipmentId, start, end, reservationId))
          throw new AppError(
            409,
            "RESERVATION_CONFLICT",
            "That equipment is already reserved for part of this time.",
          );
        if (
          await model.equipmentCooldown(equipmentId, start, end, reservationId)
        )
          throw new AppError(
            409,
            "RESERVATION_COOLDOWN",
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between reservations for the same equipment, including other members' bookings.`,
          );
      } else {
        const room = await new RoomModel(db).findForUpdate(roomId!);
        if (!room) throw new AppError(404, "NOT_FOUND", "Room not found.");
        if (room.status !== "available")
          throw new AppError(
            409,
            "ROOM_UNAVAILABLE",
            "This room is not available for reservations.",
          );
        location = room.location;
        resourceName = room.name;
        if (await model.roomOverlaps(room.id, start, end, reservationId))
          throw new AppError(
            409,
            "RESERVATION_CONFLICT",
            "That room is already reserved for part of this time.",
          );
        if (
          await model.roomCooldown(targetId, room.id, start, end, reservationId)
        )
          throw new AppError(
            409,
            "RESERVATION_COOLDOWN",
            `Leave at least ${RESERVATION_COOLDOWN_MINUTES} minutes between your reservations for the same room.`,
          );
      }

      if (maintenance) {
        const target = await new EquipmentModel(db).findForUpdate(equipmentId!);
        const rate = target!.rate === null ? null : Number(target!.rate);
        const source = (await db.query('SELECT hourlyrate FROM equipment WHERE equipmentid=$1', [maintenance.sourceEquipmentId])).rows[0];
        if (maintenance.preview) return {
          reservationId, expectedRevision, equipmentId, equipmentName: resourceName,
          startTime: start.toISOString(), endTime: end.toISOString(),
          oldRate: source.hourlyrate === null ? null : Number(source.hourlyrate), rate,
        };
        if (maintenance.expectedRate !== rate)
          throw new AppError(409, "RATE_CHANGED", "The hourly rate changed. Review this move again before confirming.");
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
        throw new AppError(404, "NOT_FOUND", "Reservation not found.");
      if (!keepSponsorLink) await new MinorSupervision(db,this.timeZone).recordBooking(targetId,reservation.id);
      await new StaffModel(db).audit(
        actorId,
        targetId,
        "reservation.override.updated",
        "reservation",
        reservation.id,
        "Staff reservation override",
        before,
        reservation,
      );
      await enqueueNotification(db, {
        userId: targetId,
        kind: "reservation_updated",
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

  async cancelAny(actorId: number, reservationId: number, maintenance?: { sourceEquipmentId: number; expectedRevision: unknown }) {
    return transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(actorId);
      const actor = await new UserModel(db, this.timeZone).findById(actorId);
      if (!actor || actor.roles.includes("instructor"))
        throw new AppError(
          403,
          "INSTRUCTOR_BOOKING_FORBIDDEN",
          "Instructor accounts cannot create reservations.",
        );
      if (!actor.roles.some((role) => ["staff", "admin"].includes(role)))
        throw new AppError(
          403,
          "STAFF_REQUIRED",
          "Only staff can cancel another member reservation.",
        );

      const model = new ReservationModel(db);
      const before = await model.find(reservationId, true);
      if (!before)
        throw new AppError(404, "NOT_FOUND", "Reservation not found.");
      if (
        !(await new PermissionModel(db).allows(
          actor,
          "reservation",
          "update",
          before.userId,
        ))
      )
        throw new AppError(
          403,
          "PERMISSION_REQUIRED",
          "Reservation update permission is required.",
        );
      if (
        (
          await db.query(
            "SELECT id FROM app_training_class WHERE reservation_id=$1",
            [reservationId],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          "CLASS_WORKFLOW_REQUIRED",
          "Cancel this training through Classes to preserve enrollment records.",
        );
      if (maintenance && (before.equipmentId !== maintenance.sourceEquipmentId || before.revision !== positiveId(maintenance.expectedRevision, "Revision")))
        throw new AppError(409, "STALE_RECORD", "This reservation changed. Refresh it before cancelling.");
      const result = await model.cancelAny(reservationId);
      if (!result)
        throw new AppError(
          409,
          "INVALID_STATUS",
          "Only active reservations can be cancelled.",
        );
      await new StaffModel(db).audit(
        actorId,
        before.userId,
        "reservation.override.cancelled",
        "reservation",
        result.id,
        "Staff reservation override",
        before,
        result,
      );
      await enqueueNotification(db, {
        userId: before.userId,
        kind: "reservation_cancelled",
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
