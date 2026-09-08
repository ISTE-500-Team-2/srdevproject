import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, positiveId, textField } from '../domain.js';
import { authState } from '../middleware/auth.js';
import { UserModel } from '../models/UserModel.js';
import { EligibilityModel } from '../models/EligibilityModel.js';
import { AccessService } from '../services/AccessService.js';
import { MemberModel } from '../models/MemberModel.js';

export class MemberController {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}
  certifications = async (_req: Request, res: Response) => {
    res.json({
      data: await new MemberModel(this.pool).certifications(
        authState(res).user.id,
      ),
    });
  };
  profile = async (req: Request, res: Response) => {
    res.json({
      data: await new UserModel(this.pool).updateProfile(
        authState(res).user.id,
        textField(req.body.firstName, 'First name', 50),
        textField(req.body.lastName, 'Last name', 50),
        textField(req.body.phone, 'Phone', 15),
      ),
    });
  };
  waivers = async (_req: Request, res: Response) => {
    res.json({
      data: await new EligibilityModel(this.pool, this.timeZone).waivers(
        authState(res).user.id,
      ),
    });
  };
  signWaiver = async (req: Request, res: Response) => {
    const id = positiveId(req.params.id);
    const userId = authState(res).user.id;
    if (req.body.accepted !== true)
      throw new AppError(
        400,
        'CONSENT_REQUIRED',
        'Explicit agreement is required.',
      );
    const waivers = await new EligibilityModel(
      this.pool,
      this.timeZone,
    ).waivers(userId);
    if (!waivers.some((w) => w.id === id))
      throw new AppError(
        404,
        'NOT_FOUND',
        'This is not a current required waiver.',
      );
    await new MemberModel(this.pool).signWaiver(userId, id);
    res.json({
      data: await new EligibilityModel(this.pool, this.timeZone).waivers(
        userId,
      ),
    });
  };
  overview = async (_req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const model = new EligibilityModel(this.pool, this.timeZone);
    const [entitlement, waivers, reservations, checkIns] = await Promise.all([
      model.entitlement(userId, new Date()),
      model.waivers(userId),
      new MemberModel(this.pool).activeReservationCount(userId),
      new MemberModel(this.pool).recentCheckIns(userId),
    ]);
    const reasons: string[] = [];
    if (!entitlement.membership && !entitlement.dayPass)
      reasons.push('Active membership or day pass required');
    if (!waivers.length)
      reasons.push('Required policies have not been configured');
    else if (waivers.some((w) => !w.signed))
      reasons.push('Required policies and waivers need your signature');
    res.json({
      data: {
        entitlement,
        pendingWaivers: waivers.filter((w) => !w.signed).length,
        activeReservations: reservations,
        canCheckIn: reasons.length === 0,
        reasons,
        recentCheckIns: checkIns,
      },
    });
  };
  checkIn = async (req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const location = textField(req.body.location, 'Location', 100);
    const record = await transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      await access.assertActiveUser(userId);
      await access.assertEntitlement(userId, new Date());
      await access.assertWaivers(userId);
      return new MemberModel(db).createCheckIn(userId, location);
    });
    res.status(201).json({ data: record });
  };
}
