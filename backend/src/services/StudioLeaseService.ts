import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, positiveId } from '../domain.js';
import { localStudioDate, studioLeaseWindow } from '../studioDomain.js';
import { StudioModel } from '../models/StudioModel.js';
import { AccessService } from './AccessService.js';

export class StudioLeaseService {
    constructor(
        private pool: Pool,
        private timeZone: string,
    ) { }

    async list() {
        const studios = await new StudioModel(this.pool).list();
        return studios.map((studio) => ({ ...studio, monthlyRate: Number(studio.monthlyRate) }));
    }

    async availability(startDate: unknown, months: unknown) {
        const window = studioLeaseWindow(startDate, months, this.timeZone);
        const studios = await new StudioModel(this.pool).availableForWindow(
            window.startDate,
            window.endDate,
        );
        return { ...window, studios };
    }

    async listForUser(userId: number) {
        const leases = await new StudioModel(this.pool).listForUser(userId);
        return leases.map((lease) => ({
            ...lease,
            monthlyRate: Number(lease.monthlyRate),
            estimatedTotal: Number(lease.monthlyRate) * lease.months,
        }));
    }

    async create(userId: number, input: {
        studioId?: unknown;
        startDate?: unknown;
        months?: unknown;
    }) {
        const studioId = positiveId(input.studioId, 'Studio');
        const window = studioLeaseWindow(input.startDate, input.months, this.timeZone);
        try {
            const lease = await transaction(this.pool, async (db) => {
                const access = new AccessService(db, this.timeZone);
                await access.assertActiveUser(userId);
                const membership = await db.query<{ active: boolean }>(
                    `SELECT EXISTS (
            SELECT 1 FROM user_membership
            WHERE userid=$1 AND status='active'
              AND startdate <= $2::date AND end_date >= $3::date
          ) AS active`,
                    [userId, window.startDate, window.endDate],
                );
                if (!membership.rows[0]!.active)
                    throw new AppError(
                        403,
                        'MEMBERSHIP_REQUIRED',
                        'An active membership covering the full studio lease term is required.',
                    );

                // Serializing against the studio row protects API writers; the exclusion
                // constraint also protects against overlapping writes from other clients.
                const model = new StudioModel(db);
                const studio = await model.findForUpdate(studioId);
                if (!studio)
                    throw new AppError(404, 'NOT_FOUND', 'Studio space not found.');
                if (await model.overlaps(studioId, window.startDate, window.endDate))
                    throw new AppError(
                        409,
                        'STUDIO_UNAVAILABLE',
                        'That studio is already leased for part of the selected dates.',
                    );
                return model.create({
                    studioId,
                    userId,
                    ...window,
                    monthlyRate: studio.monthlyRate,
                });
            });
            return {
                ...lease,
                monthlyRate: Number(lease.monthlyRate),
                estimatedTotal: Number(lease.monthlyRate) * lease.months,
            };
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === '23P01'
            )
                throw new AppError(
                    409,
                    'STUDIO_UNAVAILABLE',
                    'That studio is already leased for part of the selected dates.',
                );
            throw error;
        }
    }

    async cancel(leaseId: unknown, userId: number) {
        const id = positiveId(leaseId, 'Lease');
        const result = await new StudioModel(this.pool).cancel(
            id,
            userId,
            localStudioDate(new Date(), this.timeZone),
        );
        if (!result)
            throw new AppError(
                404,
                'NOT_FOUND',
                'No cancellable studio lease was found for this account.',
            );
        return result;
    }
}
