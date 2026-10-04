import { StaffModel } from '../models/StaffModel.js';
import { transaction } from '../db.js';
import { enqueueNotification } from '../notifications/store.js';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { authState } from '../middleware/auth.js';
import { ReservationModel } from '../models/ReservationModel.js';
import { ReservationService } from '../services/ReservationService.js';

export class ReservationController {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}
  list = async (_req: Request, res: Response) => {
    res.json({
      data: await new ReservationModel(this.pool).listForUser(
        authState(res).user.id,
      ),
    });
  };
  staffList = async (req: Request, res: Response) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (date && !dateMatch)
      throw new AppError(400, 'INVALID_INPUT', 'Date must use YYYY-MM-DD format.');
    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
      )
        throw new AppError(400, 'INVALID_INPUT', 'Date must be a valid calendar date.');
    }
    const userId =
      req.query.userId == null || req.query.userId === ''
        ? null
        : positiveId(req.query.userId, 'Member');
    const equipmentId =
      req.query.equipmentId == null || req.query.equipmentId === ''
        ? null
        : positiveId(req.query.equipmentId, 'Equipment');
    const offset =
      req.query.offset == null || req.query.offset === ''
        ? 0
        : Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError(400, 'INVALID_INPUT', 'Offset must be zero or more.');
    const rows = await new ReservationModel(this.pool).listAll({
      date,
      userId,
      equipmentId,
      offset,
    });
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      },
    });
  };
  create = async (req: Request, res: Response) => {
    res
      .status(201)
      .json({
        data: await new ReservationService(this.pool, this.timeZone).create(
          authState(res).user.id,
          req.body,
        ),
      });
  };
  update = async (req: Request, res: Response) => {
    res.json({
      data: await new ReservationService(this.pool, this.timeZone).update(
        authState(res).user.id,
        positiveId(req.params.id),
        req.body,
      ),
    });
  };
  staffCancel = async (req: Request, res: Response) => {
    res.json({
      data: await new ReservationService(this.pool, this.timeZone).cancelAny(
        authState(res).user.id,
        positiveId(req.params.id),
      ),
    });
  };
  cancel = async (req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const result = await transaction(this.pool,async db => {
      const result = await new ReservationModel(db).cancel(positiveId(req.params.id),userId);
      if (!result) {
        const existing=await db.query("SELECT status,starttime FROM reservation WHERE reservationid=$1 AND userid=$2",[positiveId(req.params.id),userId]);
        if (existing.rows[0] && ['confirmed','pending'].includes(existing.rows[0].status))
          throw new AppError(409,'CANCELLATION_NOTICE_REQUIRED','Equipment cancellations require at least 24 hours notice. Contact staff.');
      }
      if (result) await new StaffModel(db).audit(userId,userId,'reservation.cancelled','reservation',result.id,'Member cancellation with at least 24 hours notice',null,result);
      if (result) await enqueueNotification(db,{userId,kind:'reservation_cancelled',dedupeKey:`reservation-cancelled:${result.id}`,payload:{reservationId:result.id,resourceName:result.equipmentName,startsAt:new Date(result.startTime).toISOString(),endsAt:new Date(result.endTime).toISOString()}});
      return result;
    });
    if (!result)
      throw new AppError(
        404,
        'NOT_FOUND',
        'No cancellable reservation was found for this account.',
      );
    res.json({ data: result });
  };
}
