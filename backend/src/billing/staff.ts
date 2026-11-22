// Staff billing endpoints for a member (assisted purchase, stopping card renewal) act for the
// member being helped while using the staff operator's authorization.

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { transaction } from '../db.js';
import { authState, requireCsrf, requireStaff } from '../middleware/auth.js';
import { requirePermission, requireStaffPermission } from '../middleware/permissions.js';
import { StaffModel } from '../models/StaffModel.js';
import { BillingPricing } from './pricing.js';
import { MembershipBilling } from './service.js';
import { PassBilling } from './passes.js';
import { StudioStripe, type StudioStripeConfig } from '../studios/stripe.js';

/** Staff checkout uses the member's prices, payment lifecycle and webhook verification. */
export function staffPurchaseRoutes(pool: Pool, config?: StudioStripeConfig, zone = 'America/New_York') {
  const routes = Router();
  const provider = config ? new StudioStripe(config) : undefined;
  const memberships = new MembershipBilling(pool, provider);
  const passes = new PassBilling(pool, provider, zone);
  const pricing = new BillingPricing(pool);
  const path = '/admin/users/:id/purchase';
  const member = async (req: Request, res: Response, next: NextFunction) => {
    const target = await new StaffModel(pool).person(positiveId(req.params.id));
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Member not found.');
    if (target.roles.some((role: string) => role === 'admin' || role === 'staff') && !authState(res).user.roles.includes('admin'))
      throw new AppError(403, 'ADMIN_REQUIRED', 'Only administrators can manage staff accounts.');
    // Checkout refuses a restricted member's account; say it is the member's, not the staff user's.
    if (target.status !== 'active')
      throw new AppError(409, 'MEMBER_RESTRICTED', 'This member’s account isn’t active. Reactivate it before selling a plan or pass.');
    if (target.accessStatus !== 'active')
      throw new AppError(409, 'MEMBER_RESTRICTED', `This member’s access is ${target.accessStatus}. Restore it before selling a plan or pass.`);
    next();
  };
  // The prefix gate runs the target checks before Express picks a method; each route also names its
  // own requirement (already confirmed by then, so it costs nothing).
  const sell = requireStaffPermission(pool, 'entitlement', 'create');
  routes.use(path, sell, member);
  routes.get(path, sell, async (req, res) => {
    const id = positiveId(req.params.id);
    res.json({ data: { enabled: !!config, offers: await pricing.offers(id, typeof req.query.date === 'string' ? req.query.date : undefined) } });
  });
  routes.post(path, sell, requireCsrf, async (req, res) => {
    const id = positiveId(req.params.id), actor = authState(res).user;
    const plan = await new StaffModel(pool).plan(positiveId(req.body.planId));
    if (!plan?.active) throw new AppError(400, 'INVALID_PLAN', 'Choose an active plan.');
    // Record the staff initiator without storing the checkout URL or card details.
    await transaction(pool, db => new StaffModel(db).audit(actor.id, id, 'billing.assisted_checkout_requested', 'plan', plan.id,
      'Staff-assisted purchase', null, { autoRenewConsent: req.body.autoRenewConsent === true }));
    const result = plan.kind === 'day_pass'
      ? await passes.checkout(id, req.body)
      : req.body.freeMembership === true
        ? await passes.freeMembership(id, req.body)
        : await memberships.checkout(id, req.body);
    res.json({ data: result });
  });
  // A member who can't sign in (an account on hold, suspended facility access) can't stop their own
  // card renewal, and staff can't open a restricted account to do it as them, so staff stop it here on
  // the member's own terms: the same notice period and the same email. Unlike a sale, this works while
  // the member's account or access is restricted; only staff accounts stay administrator-only.
  routes.post('/admin/users/:id/memberships/:membershipId/stop-renewal', requireStaff,
    requirePermission(pool, 'entitlement', 'update', 'global'), requireCsrf, async (req, res) => {
      res.json({ data: await memberships.stopRenewal(authState(res).user.id, positiveId(req.params.id), positiveId(req.params.membershipId), req.body.reason) });
    });
  return routes;
}
