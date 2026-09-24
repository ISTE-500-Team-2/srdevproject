import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { AppError } from '../domain.js';
import { authState } from './auth.js';
import { PermissionModel } from '../models/PermissionModel.js';

// Installed per route before controllers. Only server-resolved ownership is accepted.
export function requirePermission(pool: Pool, resource: string, action: string, scope: 'own' | 'global' = 'global') {
  return async (_req: Request, res: Response, next: NextFunction) => {
    const user = authState(res).user;
    if (resource === 'reservation' && action === 'create' && user.roles.includes('instructor'))
      throw new AppError(403,'INSTRUCTOR_BOOKING_FORBIDDEN','Instructor accounts cannot create reservations.');
    if (!await new PermissionModel(pool).allows(user,resource,action,scope === 'own' ? user.id : null))
      throw new AppError(403,'PERMISSION_REQUIRED','This operation is not permitted for your role.');
    next();
  };
}
