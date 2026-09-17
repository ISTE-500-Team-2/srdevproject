import type { Database } from '../db.js';

export interface EquipmentRecord {
  id: number;
  name: string;
  type: string;
  rate: string | null;
  image: string;
  status: string;
  waiverRequired: boolean;
  certId: number | null;
  certification: string | null;
  location: string;
}
const columns = `e.equipmentid AS id,e.name,COALESCE(e.category,e.name) AS type,e.hourlyrate AS rate,
  COALESCE(e.imagepath,'/assets/3d-printer.webp') AS image,COALESCE(e.status,'unavailable') AS status,
  COALESCE(e.waiverrequired,false) AS "waiverRequired",e.certid AS "certId",c.name AS certification,
  e.location`;

export class EquipmentModel {
  constructor(private db: Database) {}
  async list(): Promise<EquipmentRecord[]> {
    return (
      await this.db.query<EquipmentRecord>(
        `SELECT ${columns} FROM equipment e LEFT JOIN certifications c USING (certid) ORDER BY e.equipmentid`,
      )
    ).rows;
  }
  async findForUpdate(id: number): Promise<EquipmentRecord | null> {
    return (
      (
        await this.db.query<EquipmentRecord>(
          `SELECT ${columns} FROM equipment e LEFT JOIN certifications c USING (certid) WHERE e.equipmentid=$1 FOR UPDATE OF e`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
}
