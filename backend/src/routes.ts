import {billingRoutes} from './billing/routes.js';
import {studioRoutes} from './studios/routes.js';
import { requirePermission } from './middleware/permissions.js';
import { WaiverRecordsController } from './controllers/WaiverRecordsController.js';
import { NotificationPreferencesController } from "./controllers/NotificationPreferencesController.js";
import { Router } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { AuthController } from "./controllers/AuthController.js";
import { EquipmentController } from "./controllers/EquipmentController.js";
import { ReservationController } from "./controllers/ReservationController.js";
import { MemberController } from "./controllers/MemberController.js";
import {
  requireUser,
  requireCsrf,
  requireStaff,
  authRateLimit,
} from "./middleware/auth.js";
import { StaffController } from "./controllers/StaffController.js";

export function apiRoutes(pool: Pool, config: AppConfig) {
  const routes = Router();
  const auth = new AuthController(pool, config);
  const notifications = new NotificationPreferencesController(pool);
  const waiverRecords = new WaiverRecordsController(pool);
  const member = new MemberController(pool, config.timeZone);
  const equipment = new EquipmentController(pool, config.timeZone);
  const reservations = new ReservationController(pool, config.timeZone);
  const staff = new StaffController(pool, config.timeZone);
  const permit = (resource: string, action: string, scope: "own" | "global" = "global") => requirePermission(pool,resource,action,scope);
  const protectedRoute = requireUser(pool, config);
  const rateLimit = authRateLimit();
  routes.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ data: { status: "ok", database: "connected" } });
  });
  routes.get("/config", (_req, res) =>
    res.json({
      data: { demoLogin: config.demoLogin, timeZone: config.timeZone },
    }),
  );
  routes.post("/auth/login", rateLimit, auth.login);
  routes.post("/auth/register", rateLimit, auth.register);
  routes.post("/auth/confirm", rateLimit, auth.confirm);
  routes.post("/auth/confirmation", rateLimit, auth.confirmation);
  if (config.demoLogin) routes.post("/auth/demo", rateLimit, auth.demo);
  routes.get("/auth/csrf", auth.csrf);
  routes.post("/auth/refresh", rateLimit, auth.refresh);
  routes.get("/auth/session", protectedRoute, auth.current);
  routes.post("/auth/logout", protectedRoute, requireCsrf, auth.logout);
  routes.use(protectedRoute);
  routes.use(studioRoutes(pool,config.timeZone,config.studioStripe));
  routes.use(billingRoutes(pool,config.studioStripe));

  routes.get("/equipment", permit("equipment","read","own"), equipment.list);
  routes.get("/reservations", permit("reservation","read","own"), reservations.list);
  routes.post("/reservations", permit("reservation","create","own"), requireCsrf, reservations.create);
  routes.post("/reservations/:id/cancel", permit("reservation","update","own"), requireCsrf, reservations.cancel);
  routes.get("/me/overview", permit("user","read","own"), member.overview);
  routes.get("/me/notifications", permit("notification","read","own"), notifications.get);
  routes.patch("/me/notifications", permit("notification","update","own"), requireCsrf, notifications.update);
  routes.patch("/me/profile", permit("user","update","own"), requireCsrf, member.profile);
  routes.get("/me/signed-waivers", permit("waiver","read","own"), waiverRecords.mine);
  routes.get("/me/signed-waivers/:id/copy", permit("waiver","read","own"), waiverRecords.ownCopy);
  routes.get("/me/waivers", permit("waiver","read","own"), member.waivers);
  routes.get("/me/certifications", permit("certification","read","own"), member.certifications);
  routes.post("/me/waivers/:id/sign", permit("waiver","create","own"), requireCsrf, member.signWaiver);
  routes.post("/me/check-ins", permit("check_in","create","own"), requireCsrf, member.checkIn);
  routes.get("/plans", permit("plan","read","own"), member.plans);
  routes.get("/me/memberships", permit("entitlement","read","own"), member.memberships);
  routes.get("/me/payments", permit("payment","read","own"), member.payments);

  routes.use("/admin", requireStaff);
  routes.get("/admin/plans", permit("plan","read","global"), staff.plans);
  routes.post("/admin/plans", permit("plan","create","global"), requireCsrf, staff.createPlan);
  routes.patch("/admin/plans/:id", permit("plan","update","global"), requireCsrf, staff.updatePlan);
  routes.get("/admin/users", permit("user","read","global"), staff.users);
  routes.get("/admin/users/:id", permit("user","read","global"), staff.user);
  routes.get("/admin/users/:id/signed-waivers", permit("waiver","read","global"), waiverRecords.member);
  routes.get("/admin/users/:id/signed-waivers/:waiverId/copy", permit("waiver","read","global"), waiverRecords.memberCopy);
  routes.patch("/admin/users/:id/signed-waivers/:waiverId/expiry", permit("waiver","update","global"), requireCsrf, waiverRecords.expiry);
  routes.patch("/admin/users/:id/profile", permit("user","update","global"), requireCsrf, staff.profile);
  routes.post("/admin/users/:id/access", permit("user_access","update","global"), requireCsrf, staff.access);
  routes.post("/admin/users/:id/role", permit("user_role","update","global"), requireCsrf, staff.role);
  routes.post("/admin/users/:id/entitlements", permit("entitlement","create","global"), requireCsrf, staff.issue);
  routes.post(
    "/admin/users/:id/entitlements/:kind/:entitlementId/status",
    permit("entitlement","update"),
    requireCsrf,
    staff.entitlement,
  );
  routes.get("/admin/payments", permit("payment","read","global"), staff.payments);
  routes.post("/admin/payments/:id/status", permit("payment","update","global"), requireCsrf, staff.payment);
  routes.get("/admin/audit", permit("audit","read","global"), staff.audits);
  routes.get("/admin/policies", permit("policy","read","global"), staff.policies);
  routes.post("/admin/policies", permit("policy","create","global"), requireCsrf, staff.publishPolicy);
  routes.post("/admin/policies/:id/retire", permit("policy","update","global"), requireCsrf, staff.retirePolicy);
  return routes;
}
