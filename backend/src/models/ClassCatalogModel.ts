// Class templates (the catalog) and the editable details staff change on templates and sessions.
// Callers pass the pool or their transaction client.

import type { Database } from "../db.js";

/** The two tables whose title, description, roster size and image staff edit the same way. */
// Untyped rows, as where these queries used to run (a pool client); callers check what they read.
type Row = any;

export type ClassTable = 'app_class_catalog' | 'app_training_class';

export class ClassCatalogModel {
  constructor(private db: Database) {}

  async list() {
    return (await this.db.query<Row>('SELECT id,title,description,capacity,imagepath AS image,revision FROM app_class_catalog WHERE removed_at IS NULL ORDER BY id')).rows;
  }

  /** A template still in the catalog, share-locked so it cannot be removed while a session is scheduled from it. */
  async shareTemplate(id: number) {
    return (await this.db.query<Row>('SELECT * FROM app_class_catalog WHERE id=$1 AND removed_at IS NULL FOR SHARE',[id])).rows[0];
  }

  async lock(table: ClassTable, id: number) {
    return (await this.db.query<Row>(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  }

  /** A session's booking and room capacity, share-locked while its details change. */
  async shareBooking(reservationId: number) {
    return (await this.db.query<Row>(`SELECT v.status,v.starttime AT TIME ZONE 'UTC' AS starts,room.capacity
          FROM reservation v JOIN room USING(roomid) WHERE v.reservationid=$1 FOR SHARE OF v,room`, [reservationId])).rows[0];
  }

  async seatsTaken(id: number) {
    return (await this.db.query<Row>(`SELECT count(*)::int AS count FROM app_training_enrollment
          WHERE class_id=$1 AND status IN ('enrolled','attended')`, [id])).rows[0].count;
  }

  /** Match the database's unique title constraint and provide an actionable conflict. */
  async titleTaken(title: string, id: number | null) {
    await this.db.query<Row>("SELECT pg_advisory_xact_lock(hashtext('class-catalog-title'),hashtext(lower($1)))", [title]);
    return !!(await this.db.query<Row>('SELECT 1 FROM app_class_catalog WHERE lower(title)=lower($1) AND id IS DISTINCT FROM $2', [title, id])).rowCount;
  }

  async storeImage(version: string, contentType: string, image: unknown) {
    await this.db.query<Row>('INSERT INTO app_class_image(version,content_type,image) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [version, contentType, image]);
  }

  /** Creates a template, or updates `table`'s row `id`; returns the saved row. */
  async save(create: boolean, table: ClassTable, values: unknown[], id: number | null) {
    return (await this.db.query<Row>(create
      ? `INSERT INTO app_class_catalog(title,description,capacity,imagepath) VALUES($1,$2,$3,$4) RETURNING *`
      : `UPDATE ${table} SET title=$1,description=$2,capacity=$3,imagepath=$4,revision=revision+1 WHERE id=$5 RETURNING *`, create ? values : [...values, id])).rows[0];
  }

  /** Scheduling takes a shared lock on this row, so it cannot publish from a removed template. */
  async lockTemplate(id: number) {
    return (await this.db.query<Row>('SELECT * FROM app_class_catalog WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  async remove(id: number) {
    return (await this.db.query<Row>('UPDATE app_class_catalog SET removed_at=now(),revision=revision+1 WHERE id=$1 RETURNING *', [id])).rows[0];
  }
}
