import { Router } from 'express';
import type { Pool } from 'pg';
import { AppError, positiveId } from './domain.js';
import { authState, requireCsrf } from './middleware/auth.js';
import { requirePermission } from './middleware/permissions.js';
import { EquipmentMaintenanceService } from './services/EquipmentMaintenanceService.js';
import { ReservationService } from './services/ReservationService.js';
import { ReservationModel } from './models/ReservationModel.js';

/** Mounted after requireStaff. Member/account-mode requests cannot enter here. */
export function equipmentManagement(pool: Pool, timeZone: string) {
  const routes = Router();
  const equipment = new EquipmentMaintenanceService(pool, timeZone);
  const reservations = new ReservationService(pool, timeZone);
  const read = requirePermission(pool, 'equipment', 'read');
  const update = requirePermission(pool, 'equipment', 'update');
  const book = requirePermission(pool, 'reservation', 'update');
  routes.get('/admin/equipment', read, async (_req, res) => res.json({ data: await equipment.list() }));
  routes.get('/admin/equipment/:id', read, async (req, res) => res.json({ data: await equipment.detail(positiveId(req.params.id), authState(res).user) }));
  for (const action of ['outage', 'restore'] as const) routes.post(`/admin/equipment/:id/${action}`, update, requireCsrf, async (req, res) => {
    res.json({ data: await equipment.change(authState(res).user.id, positiveId(req.params.id), req.body, action === 'restore') });
  });
  routes.get('/admin/equipment/:id/bookings', read, requirePermission(pool, 'reservation', 'read'), async (req, res) => {
    const offset = req.query.offset === undefined || req.query.offset === '0' ? 0 : positiveId(req.query.offset, 'Offset');
    if (offset > 1_000_000) throw new AppError(400, 'INVALID_INPUT', 'Invalid offset.');
    const items = await new ReservationModel(pool, timeZone).upcomingEquipment(positiveId(req.params.id), offset);
    res.json({ data: { items: items.slice(0, 50), nextOffset: items.length > 50 ? offset + 50 : null } });
  });
  for (const action of ['review-move', 'move'] as const) routes.post(`/admin/equipment/:id/bookings/:bookingId/${action}`, read, book, requireCsrf, async (req, res) => {
    res.json({ data: await reservations.update(authState(res).user.id, positiveId(req.params.bookingId), {
      equipmentId: positiveId(req.body.equipmentId, 'Equipment'), expectedRevision: req.body.expectedRevision,
    }, { sourceEquipmentId: positiveId(req.params.id), preview: action === 'review-move', expectedRate: req.body.expectedRate }) });
  });
  routes.post('/admin/equipment/:id/bookings/:bookingId/cancel', read, book, requireCsrf, async (req, res) => {
    res.json({ data: await reservations.cancelAny(authState(res).user.id, positiveId(req.params.bookingId), {
      sourceEquipmentId: positiveId(req.params.id), expectedRevision: req.body.expectedRevision,
    }) });
  });
  return routes;
}
