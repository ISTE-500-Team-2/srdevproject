// Read-only HTTP adapter for the room catalog; room bookings are handled by ReservationService.

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { authState } from '../middleware/auth.js';
import { RoomModel } from '../models/RoomModel.js';

export class RoomController {
  constructor(private pool: Pool) {}

  list = async (_req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const [rooms, occupied] = await Promise.all([
      new RoomModel(this.pool).list(),
      // Booked times only, never another member's identity or booking details. `mine` marks the
      // member's own bookings: only those need the 15-minute gap before another in the same room.
      this.pool.query<{roomId: number; startTime: Date; endTime: Date; mine: boolean}>(`SELECT roomid AS "roomId",
        starttime AT TIME ZONE 'UTC' AS "startTime",endtime AT TIME ZONE 'UTC' AS "endTime",userid=$1 AS mine
        FROM reservation WHERE roomid IS NOT NULL AND status IN ('pending','confirmed')
          AND endtime + interval '15 minutes' > clock_timestamp() AT TIME ZONE 'UTC'
        ORDER BY starttime`, [userId]),
    ]);
    res.json({
      data: rooms.map(room => ({
        ...room,
        occupied: occupied.rows.filter(slot => slot.roomId === room.id)
          .map(({startTime, endTime, mine}) => ({startTime, endTime, mine})),
      })),
    });
  };
}
