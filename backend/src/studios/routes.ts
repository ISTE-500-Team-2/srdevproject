import { requirePermission } from '../middleware/permissions.js';
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { AppError, positiveId } from "../domain.js";
import { authState, requireCsrf } from "../middleware/auth.js";
import { StudioService } from "./service.js";
import { StudioStripe, type StudioStripeConfig } from "./stripe.js";
export function studioRoutes(
  pool: Pool,
  zone: string,
  config?: StudioStripeConfig,
) {
  const router = Router(),
    service = new StudioService(
      pool,
      zone,
      config ? new StudioStripe(config) : undefined,
    );
  const permit = (resource: string, action: string, scope: 'own'|'global' = 'own') => requirePermission(pool,resource,action,scope);
  const user = (res: Response) => authState(res).user.id;
  router.get("/studios", permit("reservation","read"), async (_req, res) =>
    res.json({
      data: {
        studios: await service.list(),
        cardTestEnabled: !!config,
        timeZone: zone,
      },
    }),
  );
  router.get("/studio-rentals", permit("reservation","read"), async (_req, res) =>
    res.json({ data: await service.mine(user(res)) }),
  );
  router.post("/studio-rentals", permit("reservation","create"), requireCsrf, async (req, res) =>
    res.status(201).json({ data: await service.create(user(res), req.body) }),
  );
  router.post(
    "/studio-rentals/:id/payment-status",
    permit("reservation","read"),
    requireCsrf,
    async (req, res) =>
      res.json({
        data: await service.syncPayment(user(res), positiveId(req.params.id)),
      }),
  );
  router.post("/studio-rentals/:id/cancel", permit("reservation","update"), requireCsrf, async (req, res) =>
    res.json({
      data: await service.cancel(user(res), positiveId(req.params.id)),
    }),
  );
  router.get("/studio-management/rentals", permit("payment","update","global"), async (_req, res) =>
    res.json({ data: await service.staffList(user(res)) }),
  );
  router.patch(
    "/studio-management/studios/:id",
    permit("role","update","global"),
    requireCsrf,
    async (req, res) =>
      res.json({
        data: await service.configure(
          user(res),
          positiveId(req.params.id),
          req.body,
        ),
      }),
  );
  router.post(
    "/studio-management/rentals/:id/payment",
    permit("payment","update","global"),
    requireCsrf,
    async (req, res) =>
      res.json({
        data: await service.manualPay(
          user(res),
          positiveId(req.params.id),
          req.body.reference,
        ),
      }),
  );
  router.post(
    "/studio-management/rentals/:id/refund",
    permit("payment","update","global"),
    requireCsrf,
    async (req, res) =>
      res.json({
        data: await service.manualRefund(
          user(res),
          positiveId(req.params.id),
          req.body.reference,
        ),
      }),
  );
  router.post(
    "/studio-management/rentals/:id/retry-refund",
    permit("payment","update","global"),
    requireCsrf,
    async (req, res) => {
      await service.staffList(user(res));
      await service.retryRefund(positiveId(req.params.id));
      res.json({ data: { retried: true } });
    },
  );
  return router;
}
export function studioWebhook(
  pool: Pool,
  zone: string,
  config?: StudioStripeConfig,
) {
  return async (req: Request, res: Response) => {
    if (!config)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Stripe test payments are not configured.",
      );
    const provider = new StudioStripe(config);
    let event;
    try {
      event = provider.sdk.webhooks.constructEvent(
        req.body,
        req.header("stripe-signature") ?? "",
        config.webhookSecret,
      );
    } catch {
      throw new AppError(
        400,
        "INVALID_SIGNATURE",
        "Invalid Stripe webhook signature.",
      );
    }
    await new StudioService(pool, zone, provider).webhook(event);
    res.json({ received: true });
  };
}
