import type { Database } from '../db.js';

export interface StudioRecord {
    id: number;
    slug: string;
    name: string;
    size: 'Small' | 'Medium' | 'Large';
    description: string;
    monthlyRate: string;
    image: string;
    availableNow: boolean;
}

export interface StudioLeaseRecord {
    id: number;
    studioId: number;
    studioName: string;
    userId: number;
    startDate: string;
    endDate: string;
    months: number;
    monthlyRate: string;
    status: 'confirmed' | 'cancelled';
}

const studioColumns = `s.studio_id AS id,s.slug,s.name,s.size,s.description,
  s.monthly_rate AS "monthlyRate",s.image_path AS image,
  NOT EXISTS (SELECT 1 FROM app_studio_lease l WHERE l.studio_id=s.studio_id
    AND l.status='confirmed' AND l.start_date <= CURRENT_DATE AND l.end_date > CURRENT_DATE) AS "availableNow"`;
const leaseColumns = `l.lease_id AS id,l.studio_id AS "studioId",s.name AS "studioName",
  l.userid AS "userId",l.start_date::text AS "startDate",l.end_date::text AS "endDate",
  l.term_months AS months,l.monthly_rate AS "monthlyRate",l.status`;

export class StudioModel {
    constructor(private db: Database) { }

    async list(): Promise<StudioRecord[]> {
        return (
            await this.db.query<StudioRecord>(
                `SELECT ${studioColumns} FROM app_studio_space s WHERE s.active=TRUE ORDER BY s.studio_id`,
            )
        ).rows;
    }

    async availableForWindow(startDate: string, endDate: string) {
        return (
            await this.db.query<{ id: number; available: boolean }>(
                `SELECT s.studio_id AS id,NOT EXISTS (
          SELECT 1 FROM app_studio_lease l WHERE l.studio_id=s.studio_id
            AND l.status='confirmed'
            AND daterange(l.start_date,l.end_date,'[)') && daterange($1::date,$2::date,'[)')
        ) AS available
        FROM app_studio_space s WHERE s.active=TRUE ORDER BY s.studio_id`,
                [startDate, endDate],
            )
        ).rows;
    }

    async findForUpdate(id: number): Promise<StudioRecord | null> {
        return (
            await this.db.query<StudioRecord>(
                `SELECT ${studioColumns} FROM app_studio_space s
         WHERE s.studio_id=$1 AND s.active=TRUE FOR UPDATE OF s`,
                [id],
            )
        ).rows[0] ?? null;
    }

    async overlaps(studioId: number, startDate: string, endDate: string) {
        const { rows } = await this.db.query<{ exists: boolean }>(
            `SELECT EXISTS (
        SELECT 1 FROM app_studio_lease WHERE studio_id=$1 AND status='confirmed'
          AND daterange(start_date,end_date,'[)') && daterange($2::date,$3::date,'[)')
      ) AS exists`,
            [studioId, startDate, endDate],
        );
        return rows[0]!.exists;
    }

    async create(input: {
        studioId: number;
        userId: number;
        startDate: string;
        endDate: string;
        months: number;
        monthlyRate: string;
    }) {
        const { rows } = await this.db.query<{ id: number }>(
            `INSERT INTO app_studio_lease
        (studio_id,userid,start_date,end_date,term_months,monthly_rate,status)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,'confirmed')
       RETURNING lease_id AS id`,
            [input.studioId, input.userId, input.startDate, input.endDate, input.months, input.monthlyRate],
        );
        return this.findLease(rows[0]!.id);
    }

    async listForUser(userId: number): Promise<StudioLeaseRecord[]> {
        return (
            await this.db.query<StudioLeaseRecord>(
                `SELECT ${leaseColumns} FROM app_studio_lease l JOIN app_studio_space s USING (studio_id)
         WHERE l.userid=$1 ORDER BY l.start_date DESC,l.lease_id DESC LIMIT 100`,
                [userId],
            )
        ).rows;
    }

    async findLease(id: number): Promise<StudioLeaseRecord> {
        return (
            await this.db.query<StudioLeaseRecord>(
                `SELECT ${leaseColumns} FROM app_studio_lease l JOIN app_studio_space s USING (studio_id)
         WHERE l.lease_id=$1`,
                [id],
            )
        ).rows[0]!;
    }

    async cancel(id: number, userId: number, today: string) {
        const { rows } = await this.db.query<{ id: number }>(
            `UPDATE app_studio_lease SET status='cancelled'
       WHERE lease_id=$1 AND userid=$2 AND status='confirmed' AND start_date > $3::date
       RETURNING lease_id AS id`,
            [id, userId, today],
        );
        return rows[0] ?? null;
    }
}
