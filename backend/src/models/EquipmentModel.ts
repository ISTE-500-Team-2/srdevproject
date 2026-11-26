// Equipment catalog reads and row locking for booking transactions; availability changes must
// serialize with reservations.

import type { Database } from '../db.js';

export interface EquipmentRecord {
  id: number;
  name: string;
  type: string;
  rate: string | null;
  image: string;
  status: string;
  availabilityRevision: number;
  waiverRequired: boolean;
  certId: number | null;
  certification: string | null;
  trainingFeeCents: number | null;
  trainingMinutes: number | null;
  location: string;
}
// Retired catalog entries keep their history but are never listed or bookable.
const active = 'NOT EXISTS(SELECT 1 FROM app_equipment_retirement r WHERE r.equipment_id=e.equipmentid)';
const columns = `e.equipmentid AS id,e.name,COALESCE(e.category,e.name) AS type,e.hourlyrate AS rate,
  COALESCE(e.imagepath,'/assets/3d-printer.webp') AS image,COALESCE(e.status,'unavailable') AS status,
  COALESCE(e.waiverrequired,false) AS "waiverRequired",e.certid AS "certId",c.name AS certification,
  c.training_fee_cents AS "trainingFeeCents",c.training_minutes AS "trainingMinutes",
  e.location,e.availability_revision AS "availabilityRevision"`;

export class EquipmentModel {
  constructor(private db: Database) {}
  async list(): Promise<EquipmentRecord[]> {
    return (
      await this.db.query<EquipmentRecord>(
        `SELECT ${columns} FROM equipment e LEFT JOIN certifications c USING (certid) WHERE ${active} ORDER BY e.equipmentid`,
      )
    ).rows;
  }
  /** Open outages and those that ended today in `timeZone`: the public summary, not the staff maintenance view. */
  async currentOutages(timeZone: string) {
    return (await this.db.query<{ equipmentId: number; reason: string; expectedBack: string | null; startedAt: Date; endedAt: Date | null }>(`SELECT equipment_id AS "equipmentId",reason,
      expected_back::text AS "expectedBack",started_at AS "startedAt",ended_at AS "endedAt"
      FROM app_equipment_outage WHERE ended_at IS NULL OR ended_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`, [timeZone])).rows;
  }
  /** Booked intervals still running or to come, with no member identity or booking details. */
  async occupiedIntervals() {
    return (await this.db.query<{ equipmentId: number; startTime: Date; endTime: Date }>(`SELECT equipmentid AS "equipmentId",
      starttime AT TIME ZONE 'UTC' AS "startTime", endtime AT TIME ZONE 'UTC' AS "endTime"
      FROM reservation WHERE equipmentid IS NOT NULL AND status IN ('pending','confirmed')
      AND endtime + interval '15 minutes' > clock_timestamp() AT TIME ZONE 'UTC'`)).rows;
  }
  async findForUpdate(id: number): Promise<EquipmentRecord | null> {
    return (
      (
        await this.db.query<EquipmentRecord>(
          `SELECT ${columns} FROM equipment e LEFT JOIN certifications c USING (certid) WHERE e.equipmentid=$1 AND ${active} FOR UPDATE OF e`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
}
