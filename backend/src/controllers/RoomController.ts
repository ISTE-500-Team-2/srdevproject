// Read-only HTTP adapter for the room catalog; room bookings are handled by ReservationService.

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { RoomModel } from '../models/RoomModel.js';

export class RoomController {
  constructor(private pool: Pool) {}

  list = async (_req: Request, res: Response) => {
    res.json({ data: await new RoomModel(this.pool).list() });
  };
}
