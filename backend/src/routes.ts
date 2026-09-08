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
  const member = new MemberController(pool, config.timeZone);
  const equipment = new EquipmentController(pool, config.timeZone);
  const reservations = new ReservationController(pool, config.timeZone);
  const staff = new StaffController(pool, config.timeZone);
  const protectedRoute = requireUser(pool);
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
  if (config.demoLogin) routes.post("/auth/demo", rateLimit, auth.demo);
  routes.get("/auth/session", protectedRoute, auth.current);
  routes.post("/auth/logout", protectedRoute, requireCsrf, auth.logout);
  routes.use(protectedRoute);
  routes.get("/equipment", equipment.list);
  routes.get("/reservations", reservations.list);
  routes.post("/reservations", requireCsrf, reservations.create);
  routes.post("/reservations/:id/cancel", requireCsrf, reservations.cancel);
  routes.get("/me/overview", member.overview);
  routes.patch("/me/profile", requireCsrf, member.profile);
  routes.get("/me/waivers", member.waivers);
  routes.get("/me/certifications", member.certifications);
  routes.post("/me/waivers/:id/sign", requireCsrf, member.signWaiver);
  routes.post("/me/check-ins", requireCsrf, member.checkIn);
  routes.get("/plans", member.plans);
  routes.get("/me/memberships", member.memberships);
  routes.get("/me/payments", member.payments);
  routes.use("/admin", requireStaff);
  routes.get("/admin/plans", staff.plans);
  routes.post("/admin/plans", requireCsrf, staff.createPlan);
  routes.patch("/admin/plans/:id", requireCsrf, staff.updatePlan);
  routes.get("/admin/users", staff.users);
  routes.get("/admin/users/:id", staff.user);
  routes.patch("/admin/users/:id/profile", requireCsrf, staff.profile);
  routes.post("/admin/users/:id/access", requireCsrf, staff.access);
  routes.post("/admin/users/:id/role", requireCsrf, staff.role);
  routes.post("/admin/users/:id/entitlements", requireCsrf, staff.issue);
  routes.post(
    "/admin/users/:id/entitlements/:kind/:entitlementId/status",
    requireCsrf,
    staff.entitlement,
  );
  routes.get("/admin/payments", staff.payments);
  routes.post("/admin/payments/:id/status", requireCsrf, staff.payment);
  routes.get("/admin/audit", staff.audits);
  routes.get("/admin/policies", staff.policies);
  routes.post("/admin/policies", requireCsrf, staff.publishPolicy);
  routes.post("/admin/policies/:id/retire", requireCsrf, staff.retirePolicy);
  return routes;
}
