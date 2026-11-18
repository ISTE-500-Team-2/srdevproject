// Staff-assisted purchase endpoints preserve the member being helped while using the staff
// operator's authorization.

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { AppError, positiveId } from '../domain.js';
import { reasonField } from '../staffDomain.js';
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
  const member = async (req: Request, res: Response, next: NextFunction) => {
    const target = await new StaffModel(pool).person(positiveId(req.params.id));
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Member not found.');
    if (target.roles.some((role: string) => role === 'admin' || role === 'staff') && !authState(res).user.roles.includes('admin'))
      throw new AppError(403, 'ADMIN_REQUIRED', 'Only administrators can manage staff accounts.');
    next();
  };
  routes.use(path, requireStaff, requirePermission(pool, 'entitlement', 'create', 'global'), member);
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
    const result = plan.kind === 'day_pass'
      ? await passes.checkout(id, req.body)
      : req.body.freeMembership === true
        ? await passes.freeMembership(id, req.body)
        : await memberships.checkout(id, req.body);
    res.json({ data: result });
  });
  // A member who can't sign in (an account on hold, suspended facility access) can't stop their own
  // card renewal, so staff can, on the member's own terms: the same notice period and the same email.
  routes.post('/admin/users/:id/memberships/:membershipId/stop-renewal', requireStaff,
    requirePermission(pool, 'entitlement', 'update', 'global'), member, requireCsrf, async (req, res) => {
      const id = positiveId(req.params.id), membershipId = positiveId(req.params.membershipId);
      const reason = reasonField(req.body.reason);
      const billing = (await pool.query<{ id: string }>(`SELECT b.id FROM app_membership_invoice i
        JOIN app_membership_billing b ON b.id=i.billing_id WHERE i.membership_id=$1 AND b.userid=$2`, [membershipId, id])).rows[0];
      if (!billing) throw new AppError(404, 'NOT_FOUND', 'This membership isn’t paid by card, so there is no auto-renew to stop.');
      await memberships.cancel(id, billing.id);
      await transaction(pool, db => new StaffModel(db).audit(authState(res).user.id, id, 'billing.renewal_stopped', 'membership',
        membershipId, reason, null, { billingId: billing.id }));
      res.json({ data: { stopped: true } });
    });
  return routes;
}
