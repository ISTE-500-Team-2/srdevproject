import type { EquipmentBilling } from './billing/equipment.js';
import { errorIdentifier } from './logSafety.js';

export const EQUIPMENT_RECONCILE_INTERVAL_MS = 15_000;

/**
 * Owns the global equipment checkout reconciliation that catalogue reads used to
 * run, so the catalogue's occupied times stay current. Each pass first releases
 * lapsed holds whose checkout never opened (a database-only step that runs even
 * without Stripe configuration), then checks a bounded batch of expired holds
 * that have a checkout session with Stripe, releasing unpaid ones. A member's own
 * checkouts are also reconciled when they list or create reservations.
 */
export function startEquipmentReconciliation(billing: Pick<EquipmentBilling, 'reconcile'>, intervalMs = EQUIPMENT_RECONCILE_INTERVAL_MS) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = billing.reconcile().catch((error: unknown) => {
      console.error('Equipment payment reconciliation failed; retrying on the next interval', errorIdentifier(error));
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
