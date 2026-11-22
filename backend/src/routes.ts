// Central API wiring: public auth routes come first, followed by signed-in feature routes and
// resource-specific permission checks.

import { minorSupervisionRoutes } from './minorSupervision.js';
import { staffPurchaseRoutes } from './billing/staff.js';
import { equipmentManagement } from "./equipmentManagement.js";
import { ReaderRegistry } from './readerRegistry.js';
import {readerSetupRoutes} from './readerSetup.js';
import {reportRoutes} from './reports.js';
import {serviceNoticeRoutes} from './serviceNotices.js';
import {accountModeRoutes,paymentDetailsAreMemberOnly,settingsAreMemberOnly,signatureIsMemberOnly,waiverCopiesAreAdminOnly} from './accountMode.js';
import {trainingClassRoutes} from './trainingClasses.js';
import {cardManagement} from './deviceAccess.js';
import { certificationRoutes } from './certifications.js';
import {billingRoutes} from './billing/routes.js';
import {studioRoutes} from './studios/routes.js';
import { anySignedIn, requireAdmin, requirePermission, requireStaffPermission } from './middleware/permissions.js';
import { WaiverRecordsController } from './controllers/WaiverRecordsController.js';
import { NotificationPreferencesController } from "./controllers/NotificationPreferencesController.js";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { AuthController } from "./controllers/AuthController.js";
import { EquipmentController } from "./controllers/EquipmentController.js";
import { equipmentImage } from './equipmentImages.js';
import { ReservationController } from "./controllers/ReservationController.js";
import { RoomController } from "./controllers/RoomController.js";
import { MemberController } from "./controllers/MemberController.js";
import {
  requireUser,
  requireCsrf,
  requireStaff,
  authRateLimit,
  authState,
} from "./middleware/auth.js";
import { StaffController } from "./controllers/StaffController.js";

export function apiRoutes(pool: Pool, config: AppConfig, readers = new ReaderRegistry(pool,config.devices)) {
  const routes = Router();
  const auth = new AuthController(pool, config);
  const notifications = new NotificationPreferencesController(pool);
  const waiverRecords = new WaiverRecordsController(pool);
  const member = new MemberController(pool, config.timeZone);
  const equipment = new EquipmentController(pool, config.timeZone, !!config.studioStripe);
  const rooms = new RoomController(pool);
  const reservations = new ReservationController(pool, config.timeZone, config.studioStripe);
  const staff = new StaffController(pool, config.timeZone);
  const permit = (resource: string, action: string, scope: "own" | "global" = "global") => requirePermission(pool,resource,action,scope);
  // Workspace routes name staff status as well as the grant; the /admin prefix gate checks it again.
  const staffPermit = (resource: string, action: string) => requireStaffPermission(pool, resource, action);
  const protectedRoute = requireUser(pool, config);
  // Every route has its own budget, so one endpoint's traffic never spends another's allowance.
  // Sign-in counts failures only, so a busy class signing in spends nothing. Per address (an IPv6
  // /56 counts as one): 10 for one account and 30 in all, and a refused retry costs nothing, so
  // one person's typos never lock out everyone else on that address. Across every address one
  // account gets 100, which bounds guessing spread over many addresses. The price: anyone with
  // ten addresses (proxies and cloud hosts make that cheap) can keep a chosen account locked out
  // of sign-in, 15 minutes at a time; no other account is affected.
  const loginEmail = (req: Request) =>
    typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
  const loginAccountLimit = authRateLimit({ limit: 10, failuresOnly: true, key: loginEmail });
  const loginLimit = authRateLimit({ failuresOnly: true });
  const loginEmailLimit = authRateLimit({ limit: 100, failuresOnly: true, key: loginEmail, perAddress: false });
  const confirmLimit = authRateLimit({ failuresOnly: true });
  const resendLimit = authRateLimit();
  const demoLimit = authRateLimit();
  // Sign-up has its own address budget, so garbage registrations do not exhaust login attempts.
  // Every sign-up counts (each sends an email), but a class signing up together on the studio's
  // Wi-Fi fits; repeat sign-ups for one address are capped separately (stageRegistration).
  const signupLimit = authRateLimit({ limit:30, message:"Too many sign-up attempts. Please wait 15 minutes before trying again." });
  // Failed sign-ins, other members on a shared network and public reset traffic must not lock
  // people out of recovery, or administrators out of sending a reset.
  const resetMessage = "Too many password reset attempts. Please wait a few minutes and try again.";
  const resetRequestLimit = authRateLimit({ message: resetMessage });
  const resetCheckLimit = authRateLimit({ message: resetMessage });
  const resetConfirmLimit = authRateLimit({ message: resetMessage });
  const emailChangeConfirmLimit = authRateLimit({ message: resetMessage });
  const adminResetLimit = authRateLimit({ message: resetMessage });
  // Both check the current password; wrong guesses count against the person at the keyboard only.
  const operator = (_req: Request, res: Response) => { const { user, actor } = authState(res); return String((actor ?? user).id); };
  const credentialLimit = authRateLimit({ failuresOnly: true, message: "Too many password attempts. Please wait 15 minutes and try again.",
    key: operator });
  // Every email change request or resend sends mail (a link, a heads-up, or an address owner's
  // notice), so each one counts, per account wherever it signs in from.
  const emailChangeLimit = authRateLimit({ limit: 10, perAddress: false, key: operator,
    message: "Too many email change requests. Please wait 15 minutes and try again." });
  // Cookie rotations have their own bounded throttle, not the sign-in budget. Every page load
  // renews, so only failed renewals count. CSRF, origin and rotating-cookie validation are unchanged.
  const refreshLimit = authRateLimit({ limit: 120, windowMs: 60000, failuresOnly: true,
    message: "Too many session refreshes. Please retry shortly." });
  routes.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ data: { status: "ok", database: "connected" } });
  });
  routes.get("/config", (_req, res) =>
    res.json({
      data: { demoLogin: config.demoLogin, timeZone: config.timeZone },
    }),
  );
  routes.post("/auth/login", loginAccountLimit, loginLimit, loginEmailLimit, auth.login);
  routes.post("/auth/register", signupLimit, auth.register);
  routes.post("/auth/confirm", confirmLimit, auth.confirm);
  routes.post("/auth/confirmation", resendLimit, auth.confirmation);
  routes.post("/auth/password-reset", resetRequestLimit, auth.passwordReset);
  routes.post("/auth/password-reset/check", resetCheckLimit, auth.checkPasswordReset);
  routes.post("/auth/password-reset/confirm", resetConfirmLimit, auth.confirmPasswordReset);
  routes.post("/auth/email-change/confirm", emailChangeConfirmLimit, auth.confirmEmailChange);
  if (config.demoLogin) routes.post("/auth/demo", demoLimit, auth.demo);
  routes.get("/auth/csrf", auth.csrf);
  routes.post("/auth/refresh", refreshLimit, auth.refresh);
  routes.get("/auth/session", protectedRoute, auth.current);
  routes.get('/equipment-images/:version', equipmentImage(pool));
  routes.get('/class-images/:version', equipmentImage(pool, 'class'));
  routes.post("/auth/logout", protectedRoute, requireCsrf, auth.logout);
  routes.use(protectedRoute);
  routes.use(trainingClassRoutes(pool,config.timeZone));
  routes.use(minorSupervisionRoutes(pool,config.timeZone));
  routes.use(certificationRoutes(pool,config.timeZone));
  routes.use(studioRoutes(pool,config.timeZone,config.studioStripe));
  routes.use(billingRoutes(pool,config.studioStripe,config.timeZone));

  routes.get("/equipment", permit("equipment", "read", "own"), equipment.list);
  routes.get("/equipment/:id/quote", permit("equipment", "read", "own"), equipment.quote);
  routes.get("/rooms", permit("room", "read", "own"), rooms.list);
  routes.get("/reservations", permit("reservation", "read", "own"), reservations.list);
  routes.post("/reservations", permit("reservation", "create", "own"), requireCsrf, reservations.create);
  routes.post("/reservations/:id/checkout", permit("reservation", "create", "own"), requireCsrf, reservations.checkout);
  routes.post("/reservations/:id/cancel-checkout", permit("reservation", "update", "own"), requireCsrf, reservations.cancelCheckout);
  routes.post("/reservations/:id/cancel", permit("reservation", "update", "own"), requireCsrf, reservations.cancel);

  routes.get("/me/overview", permit("user", "read", "own"), member.overview);
  routes.get("/me/profile", permit("user", "read", "own"), member.me);
  routes.get("/studio/contact", anySignedIn, member.studioContact);

  routes.get("/me/notifications", permit("notification", "read", "own"), notifications.get);
  routes.patch("/me/notifications", permit("notification", "update", "own"), settingsAreMemberOnly, requireCsrf, notifications.update);

  // Every save keeps a full before-and-after copy in the change log, and people rarely edit their profile.
  // Counted per account, so one member saving over and over never blocks the others on a shared network.
  const profileLimit = authRateLimit({ limit: 60, key: operator, perAddress: false,
    message: "Too many profile saves. Please wait a few minutes and try again." });
  routes.patch("/me/profile", profileLimit, permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, member.profile);
  // Both check the current password, so they share one attempt budget.
  routes.post("/me/password", credentialLimit, permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, auth.changePassword);
  routes.post("/me/email-change", credentialLimit, emailChangeLimit, permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, auth.requestEmailChange);
  routes.post("/me/email-change/resend", emailChangeLimit, permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, auth.resendEmailChange);
  routes.delete("/me/email-change", permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, auth.cancelEmailChange);
  routes.get("/me/photo", permit("user", "read", "own"), member.photo);
  routes.put("/me/photo", permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, member.savePhoto);
  routes.delete("/me/photo", permit("user", "update", "own"), settingsAreMemberOnly, requireCsrf, member.removePhoto);
  routes.get("/me/signed-waivers", permit("waiver", "read", "own"), waiverCopiesAreAdminOnly, waiverRecords.mine);
  routes.get("/me/signed-waivers/:id/copy", permit("waiver", "read", "own"), waiverCopiesAreAdminOnly, waiverRecords.ownCopy);
  routes.get("/me/waivers", permit("waiver", "read", "own"), member.waivers);
  routes.get("/me/certifications", permit("certification", "read", "own"), member.certifications);
  routes.post("/me/waivers/:id/sign", permit("waiver", "create", "own"), signatureIsMemberOnly, requireCsrf, member.signWaiver);
  routes.post("/me/check-ins", permit("check_in", "create", "own"), requireCsrf, member.checkIn);

  routes.get("/plans", permit("plan", "read", "own"), member.plans);
  routes.get("/me/memberships", permit("entitlement", "read", "own"), member.memberships);
  routes.get("/me/payments", permit("payment", "read", "own"), member.payments);
  routes.use("/admin", requireStaff);
  routes.use(equipmentManagement(pool, config.timeZone));
  routes.use(accountModeRoutes(pool, config));
  routes.use(staffPurchaseRoutes(pool, config.studioStripe, config.timeZone));
  routes.use(reportRoutes(pool,config.timeZone));
  routes.use(serviceNoticeRoutes(pool));
  routes.use(cardManagement(pool,config.timeZone,config.devices,readers));
  routes.use(readerSetupRoutes(pool,config.timeZone,readers));
  routes.get("/admin/plans", staffPermit("plan","read"), staff.plans);
  routes.post("/admin/plans", staffPermit("plan","create"), requireCsrf, staff.createPlan);
  routes.patch("/admin/plans/:id", staffPermit("plan","update"), requireCsrf, staff.updatePlan);
  routes.get("/admin/users", staffPermit("user","read"), staff.users);
  routes.post("/admin/users/:id/password-reset", requireStaff, requireCsrf, adminResetLimit,
    requireAdmin("Only administrators can send password reset emails."), auth.adminPasswordReset);
  routes.get("/admin/users/:id", staffPermit("user","read"), staff.user);
  routes.get("/admin/users/:id/signed-waivers", staffPermit("waiver","read"), waiverRecords.member);
  routes.get("/admin/users/:id/signed-waivers/:waiverId/copy", staffPermit("waiver","read"), waiverRecords.memberCopy);
  routes.patch("/admin/users/:id/signed-waivers/:waiverId/expiry", staffPermit("waiver","update"), requireCsrf, waiverRecords.expiry);
  routes.patch("/admin/users/:id/profile", staffPermit("user","update"), requireCsrf, staff.profile);
  routes.delete("/admin/users/:id/photo", staffPermit("user","update"), requireCsrf, staff.removePhoto);
  routes.get("/admin/photos", staffPermit("user","read"), staff.photos);
  routes.post("/admin/users/:id/access", staffPermit("user_access","update"), requireCsrf, staff.access);
  routes.post("/admin/users/:id/status", staffPermit("user_access","update"), requireCsrf, staff.accountStatus);
  routes.post("/admin/users/:id/conduct", staffPermit("user_access","update"), requireCsrf, staff.conduct);
  routes.get("/admin/users/:id/requirements", staffPermit("user","read"), staff.requirements);
  routes.post("/admin/users/:id/role", staffPermit("user_role","update"), requireCsrf, staff.role);
  routes.post("/admin/users/:id/entitlements", staffPermit("entitlement","create"), requireCsrf, staff.issue);
  routes.get("/admin/users/:id/entitlements/quote", staffPermit("entitlement","create"), staff.quote);
  routes.post(
    "/admin/users/:id/entitlements/:kind/:entitlementId/status",
    staffPermit("entitlement","update"),
    requireCsrf,
    staff.entitlement,
  );
  routes.get("/admin/payments", staffPermit("payment","read"), staff.payments);
  routes.post("/admin/payments/:id/status", staffPermit("payment","update"), requireCsrf, staff.payment);
  routes.get("/admin/reservations", staffPermit("reservation","read"), reservations.staffList);
  routes.get("/admin/reservations/:id", staffPermit("reservation","read"), reservations.staffGet);
  // Staff bookings: a workspace path, so they run as the staff member even while a member's account is open.
  routes.post("/admin/reservations", staffPermit("reservation","create"), requireCsrf, reservations.create);
  routes.patch("/admin/reservations/:id", staffPermit("reservation","update"), requireCsrf, reservations.update);
  routes.post("/admin/reservations/:id/cancel", staffPermit("reservation","update"), requireCsrf, reservations.staffCancel);
  routes.get("/admin/audit", staffPermit("audit","read"), staff.audits);
  routes.get("/admin/audit/actions", staffPermit("audit","read"), staff.auditActions);
  routes.get("/admin/audit/:id", staffPermit("audit","read"), staff.auditRecord);
  routes.get("/admin/compliance", staffPermit("waiver","read"), permit("certification","read","global"), staff.compliance);
  routes.get("/admin/policies", staffPermit("policy","read"), staff.policies);
  routes.post("/admin/policies", staffPermit("policy","create"), requireCsrf, staff.publishPolicy);
  routes.post("/admin/policies/:id/retire", staffPermit("policy","update"), requireCsrf, staff.retirePolicy);
  return routes;
}
