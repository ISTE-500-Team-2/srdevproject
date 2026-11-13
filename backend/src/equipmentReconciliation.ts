import type { EquipmentBilling } from './billing/equipment.js';
import { errorIdentifier } from './logSafety.js';

export const EQUIPMENT_RECONCILE_INTERVAL_MS = 15_000;

/**
 * Owns the global equipment checkout reconciliation that catalogue reads used to
 * run: each pass checks a bounded batch of expired holds with Stripe, releasing
 * unpaid ones so the catalogue's occupied times stay current. A member's own
 * checkouts are also reconciled when they list or create reservations.
 * Without Stripe configuration each pass is a no-op.
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
