// Staff catalog and session details. Session capacity changes serialize with enrollment on the class row.
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import { AppError, positiveId, textField } from './domain.js';
import { authState, requireCsrf, requireStaff } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { StaffModel } from './models/StaffModel.js';
import { profilePhotoField } from './profilePhoto.js';

export function classManagement(pool: Pool, tz: string) {
  const routes = Router();
  const save = (catalog: boolean, create = false) => async (req: Request, res: Response) => {
    const title = textField(req.body.title, 'Title', 100);
    const description = textField(req.body.description, 'Description', 4000, 0);
    const capacity = positiveId(req.body.capacity, 'Roster size');
    if (capacity > 15) throw new AppError(400, 'CAPACITY_LIMIT', 'Classes allow at most 15 people.');
    let image = textField(req.body.image ?? '', 'Image', 255, 0) || null;
    if (image && !/^\/(?!\/)/.test(image) && !/^https:\/\//i.test(image))
      throw new AppError(400, 'INVALID_INPUT', 'Use an image path starting with / or an HTTPS URL.');
    const upload = req.body.imageUpload === undefined ? null : profilePhotoField(req.body.imageUpload);
    const table = catalog ? 'app_class_catalog' : 'app_training_class';
    const data = await transaction(pool, async db => {
      const id = create ? null : positiveId(req.params.id);
      const before = id === null ? null : (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (id !== null && (!before || (catalog && before.removed_at))) throw new AppError(404, 'NOT_FOUND', 'Class not found.');
      if (before && before.revision !== positiveId(req.body.expectedRevision, 'Revision'))
        throw new AppError(409, 'STALE_RECORD', 'This class changed. Close the editor and reload before trying again.');
      if (!catalog) {
        const booking = (await db.query(`SELECT v.status,v.starttime AT TIME ZONE 'UTC' AS starts,room.capacity
          FROM reservation v JOIN room USING(roomid) WHERE v.reservationid=$1 FOR SHARE OF v,room`, [before.reservation_id])).rows[0];
        if (before.status !== 'scheduled' || booking.status !== 'confirmed' || booking.starts <= new Date())
          throw new AppError(409, 'CLASS_CLOSED', 'Only upcoming scheduled classes can be edited.');
        if (booking.capacity !== null && capacity > booking.capacity)
          throw new AppError(400, 'CAPACITY_LIMIT', 'Roster size cannot exceed the room capacity.');
        const count = (await db.query(`SELECT count(*)::int AS count FROM app_training_enrollment
          WHERE class_id=$1 AND status IN ('enrolled','attended')`, [id])).rows[0].count;
        if (capacity < count) throw new AppError(409, 'ROSTER_TOO_SMALL', `Keep at least ${count} seats for the people already registered.`);
      } else {
        // Match the database's unique title constraint and provide an actionable conflict.
        await db.query("SELECT pg_advisory_xact_lock(hashtext('class-catalog-title'),hashtext(lower($1)))", [title]);
        if ((await db.query('SELECT 1 FROM app_class_catalog WHERE lower(title)=lower($1) AND id IS DISTINCT FROM $2', [title, id])).rowCount)
          throw new AppError(409, 'DUPLICATE_NAME', 'Another class already uses this title. Choose a different title.');
      }
      if (upload) {
        await db.query('INSERT INTO app_class_image(version,content_type,image) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [upload.version, upload.contentType, upload.image]);
        image = `/api/class-images/${upload.version}`;
      }
      const values = [title, description, capacity, image];
      const after = (await db.query(create
        ? `INSERT INTO app_class_catalog(title,description,capacity,imagepath) VALUES($1,$2,$3,$4) RETURNING *`
        : `UPDATE ${table} SET title=$1,description=$2,capacity=$3,imagepath=$4,revision=revision+1 WHERE id=$5 RETURNING *`, create ? values : [...values, id])).rows[0];
      await new StaffModel(db, tz).audit(authState(res).user.id, null, create ? 'class.catalog_created' : catalog ? 'class.catalog_updated' : 'class.updated', catalog ? 'class_catalog' : 'training_class', after.id, 'Class details changed in staff workspace', before, after);
      return after;
    });
    res.status(create ? 201 : 200).json({ data });
  };
  routes.post('/classes/catalog', requireStaff, requirePermission(pool, 'certification', 'create'), requireCsrf, save(true, true));
  routes.put('/classes/catalog/:id', requireStaff, requirePermission(pool, 'certification', 'update'), requireCsrf, save(true));
  routes.put('/classes/:id', requireStaff, requirePermission(pool, 'certification', 'update'), requireCsrf, save(false));
  routes.delete('/classes/catalog/:id', requireStaff, requirePermission(pool, 'certification', 'delete'), requireCsrf, async (req, res) => {
    const id = positiveId(req.params.id);
    const data = await transaction(pool, async db => {
      // Scheduling takes a shared lock on this row, so it cannot publish from a removed template.
      const before = (await db.query('SELECT * FROM app_class_catalog WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before || before.removed_at) throw new AppError(404, 'NOT_FOUND', 'Class not found.');
      if (before.revision !== positiveId(req.body.expectedRevision, 'Revision'))
        throw new AppError(409, 'STALE_RECORD', 'This class changed. Close the editor and reload before removing it.');
      const after = (await db.query('UPDATE app_class_catalog SET removed_at=now(),revision=revision+1 WHERE id=$1 RETURNING *', [id])).rows[0];
      await new StaffModel(db, tz).audit(authState(res).user.id, null, 'class.catalog_removed', 'class_catalog', id,
        'Removed from catalog; existing sessions and enrollment preserved', before, after);
      return { id };
    });
    res.json({ data });
  });
  return routes;
}
