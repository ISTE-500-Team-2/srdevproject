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
    const result = await new ReservationModel(this.pool).cancel(
      positiveId(req.params.id),
      authState(res).user.id,
    );
    if (!result)
      throw new AppError(
        404,
        'NOT_FOUND',
        'No cancellable reservation was found for this account.',
      );
    res.json({ data: result });
  };
}
