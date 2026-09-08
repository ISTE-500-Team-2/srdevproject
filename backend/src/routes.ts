import { Router } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { AuthController } from './controllers/AuthController.js';
import { EquipmentController } from './controllers/EquipmentController.js';
import { ReservationController } from './controllers/ReservationController.js';
import { MemberController } from './controllers/MemberController.js';
import { requireUser, requireCsrf, authRateLimit } from './middleware/auth.js';

export function apiRoutes(pool: Pool, config: AppConfig) {
  const routes = Router();
  const auth = new AuthController(pool, config);
  const member = new MemberController(pool, config.timeZone);
  const equipment = new EquipmentController(pool, config.timeZone);
  const reservations = new ReservationController(pool, config.timeZone);
  const protectedRoute = requireUser(pool);
  const rateLimit = authRateLimit();
  routes.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok', database: 'connected' } });
  });
  routes.get('/config', (_req, res) =>
    res.json({
      data: { demoLogin: config.demoLogin, timeZone: config.timeZone },
    }),
  );
  routes.post('/auth/login', rateLimit, auth.login);
  routes.post('/auth/register', rateLimit, auth.register);
  if (config.demoLogin) routes.post('/auth/demo', rateLimit, auth.demo);
  routes.get('/auth/session', protectedRoute, auth.current);
  routes.post('/auth/logout', protectedRoute, requireCsrf, auth.logout);
  routes.use(protectedRoute);
  routes.get('/equipment', equipment.list);
  routes.get('/reservations', reservations.list);
  routes.post('/reservations', requireCsrf, reservations.create);
  routes.post('/reservations/:id/cancel', requireCsrf, reservations.cancel);
  routes.get('/me/overview', member.overview);
  routes.patch('/me/profile', requireCsrf, member.profile);
  routes.get('/me/waivers', member.waivers);
  routes.get('/me/certifications', member.certifications);
  routes.post('/me/waivers/:id/sign', requireCsrf, member.signWaiver);
  routes.post('/me/check-ins', requireCsrf, member.checkIn);
  return routes;
}
