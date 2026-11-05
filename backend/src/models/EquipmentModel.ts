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
