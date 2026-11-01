import { Router } from 'express';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { transaction } from '../db.js';
import { authState, requireCsrf, requireStaff } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
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
  routes.use(path, requireStaff, requirePermission(pool, 'entitlement', 'create', 'global'), async (req, res, next) => {
    const target = await new StaffModel(pool).person(positiveId(req.params.id));
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Member not found.');
    if (target.roles.some((role: string) => role === 'admin' || role === 'staff') && !authState(res).user.roles.includes('admin'))
      throw new AppError(403, 'ADMIN_REQUIRED', 'Only administrators can manage staff accounts.');
    next();
  });
  routes.get(path, async (req, res) => {
    const id = positiveId(req.params.id);
    res.json({ data: { enabled: !!config, offers: await pricing.offers(id, typeof req.query.date === 'string' ? req.query.date : undefined) } });
  });
  routes.post(path, requireCsrf, async (req, res) => {
    const id = positiveId(req.params.id), actor = authState(res).user;
    const plan = await new StaffModel(pool).plan(positiveId(req.body.planId));
    if (!plan?.active) throw new AppError(400, 'INVALID_PLAN', 'Choose an active plan.');
    // Record the staff initiator without storing the checkout URL or card details.
    await transaction(pool, db => new StaffModel(db).audit(actor.id, id, 'billing.assisted_checkout_requested', 'plan', plan.id,
      'Staff-assisted purchase', null, { autoRenewConsent: req.body.autoRenewConsent === true }));
    const returnPath = `/admin/members?member=${id}`;
    const result = plan.kind === 'day_pass'
      ? await passes.checkout(id, req.body, returnPath)
      : req.body.freeMembership === true
        ? await passes.freeMembership(id, req.body)
        : await memberships.checkout(id, req.body, returnPath);
    res.json({ data: result });
  });
  return routes;
}
