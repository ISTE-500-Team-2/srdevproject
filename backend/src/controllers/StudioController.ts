import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { authState } from '../middleware/auth.js';
import { StudioLeaseService } from '../services/StudioLeaseService.js';

export class StudioController {
    constructor(
        private pool: Pool,
        private timeZone: string,
    ) { }

    list = async (_req: Request, res: Response) => {
        res.json({ data: await new StudioLeaseService(this.pool, this.timeZone).list() });
    };

    availability = async (req: Request, res: Response) => {
        res.json({
            data: await new StudioLeaseService(this.pool, this.timeZone).availability(
                req.query.startDate,
                req.query.months,
            ),
        });
    };

    listLeases = async (_req: Request, res: Response) => {
        res.json({
            data: await new StudioLeaseService(this.pool, this.timeZone).listForUser(
                authState(res).user.id,
            ),
        });
    };

    create = async (req: Request, res: Response) => {
        res.status(201).json({
            data: await new StudioLeaseService(this.pool, this.timeZone).create(
                authState(res).user.id,
                req.body,
            ),
        });
    };

    cancel = async (req: Request, res: Response) => {
        res.json({
            data: await new StudioLeaseService(this.pool, this.timeZone).cancel(
                req.params.id,
                authState(res).user.id,
            ),
        });
    };
}
