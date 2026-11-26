// Staff catalog and session details. Session capacity changes serialize with enrollment on the class row.
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import { AppError, positiveId, textField } from './domain.js';
import { authState, requireCsrf, requireStaff } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { ClassCatalogModel } from './models/ClassCatalogModel.js';
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
      const classes = new ClassCatalogModel(db);
      const id = create ? null : positiveId(req.params.id);
      const before = id === null ? null : await classes.lock(table, id);
      if (id !== null && (!before || (catalog && before.removed_at))) throw new AppError(404, 'NOT_FOUND', 'Class not found.');
      if (before && before.revision !== positiveId(req.body.expectedRevision, 'Revision'))
        throw new AppError(409, 'STALE_RECORD', 'This class changed. Close the editor and reload before trying again.');
      if (!catalog) {
        const booking = await classes.shareBooking(before.reservation_id);
        if (before.status !== 'scheduled' || booking.status !== 'confirmed' || booking.starts <= new Date())
          throw new AppError(409, 'CLASS_CLOSED', 'Only upcoming scheduled classes can be edited.');
        if (booking.capacity !== null && capacity > booking.capacity)
          throw new AppError(400, 'CAPACITY_LIMIT', 'Roster size cannot exceed the room capacity.');
        const count = await classes.seatsTaken(id!);
        if (capacity < count) throw new AppError(409, 'ROSTER_TOO_SMALL', `Keep at least ${count} seats for the people already registered.`);
      } else {
        // Match the database's unique title constraint and provide an actionable conflict.
        if (await classes.titleTaken(title, id))
          throw new AppError(409, 'DUPLICATE_NAME', 'Another class already uses this title. Choose a different title.');
      }
      if (upload) {
        await classes.storeImage(upload.version, upload.contentType, upload.image);
        image = `/api/class-images/${upload.version}`;
      }
      const values = [title, description, capacity, image];
      const after = await classes.save(create, table, values, id);
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
      const classes = new ClassCatalogModel(db);
      const before = await classes.lockTemplate(id);
      if (!before || before.removed_at) throw new AppError(404, 'NOT_FOUND', 'Class not found.');
      if (before.revision !== positiveId(req.body.expectedRevision, 'Revision'))
        throw new AppError(409, 'STALE_RECORD', 'This class changed. Close the editor and reload before removing it.');
      const after = await classes.remove(id);
      await new StaffModel(db, tz).audit(authState(res).user.id, null, 'class.catalog_removed', 'class_catalog', id,
        'Removed from catalog; existing sessions and enrollment preserved', before, after);
      return { id };
    });
    res.json({ data });
  });
  return routes;
}
