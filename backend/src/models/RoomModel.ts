import type { Database } from '../db.js';

export interface RoomRecord {
  id: number;
  name: string;
  location: string;
  capacity: number | null;
  status: string;
}

const columns = `roomid AS id,name,location,capacity,COALESCE(status,'unavailable') AS status`;

export class RoomModel {
  constructor(private db: Database) {}

  async list(): Promise<RoomRecord[]> {
    return (
      await this.db.query<RoomRecord>(
        `SELECT ${columns} FROM room ORDER BY name,roomid`,
      )
    ).rows;
  }

  async findForUpdate(id: number): Promise<RoomRecord | null> {
    return (
      (
        await this.db.query<RoomRecord>(
          `SELECT ${columns} FROM room WHERE roomid=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
}
