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
