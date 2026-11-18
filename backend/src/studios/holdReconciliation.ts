import { errorIdentifier } from "../logSafety.js";
import type { StudioService } from "./service.js";

export const STUDIO_HOLD_RECONCILE_INTERVAL_MS = 60_000;

/**
 * Settles studio card holds whose deadline passed without Stripe's verdict arriving (a lost or late
 * webhook): each pass reconciles a bounded batch with Stripe, so such a hold can't keep a studio
 * blocked for days. Passes never overlap. Without Stripe configuration each pass is a no-op.
 */
export function startStudioHoldReconciliation(
  studios: Pick<StudioService, "reconcileLapsedHolds">,
  intervalMs = STUDIO_HOLD_RECONCILE_INTERVAL_MS,
) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = studios
      .reconcileLapsedHolds()
      .catch((error: unknown) => {
        console.error("Studio hold reconciliation failed; retrying on the next interval", errorIdentifier(error));
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
