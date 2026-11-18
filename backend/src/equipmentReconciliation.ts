import type { EquipmentBilling } from './billing/equipment.js';
import type { PassBilling } from './billing/passes.js';
import { errorIdentifier } from './logSafety.js';

export const EQUIPMENT_RECONCILE_INTERVAL_MS = 15_000;

/**
 * Owns the global equipment checkout reconciliation that catalogue reads used to
 * run, so the catalogue's occupied times stay current. Each pass first releases
 * lapsed holds whose checkout never opened (a database-only step that runs even
 * without Stripe configuration), then checks a bounded batch of expired holds
 * that have a checkout session with Stripe, releasing unpaid ones. A member's own
 * checkouts are also reconciled when they list or create reservations.
 * The same tick retries refund work left by paid equipment and day-pass checkouts.
 */
export function startEquipmentReconciliation(
  billing: Pick<EquipmentBilling, 'reconcile'>,
  intervalMs = EQUIPMENT_RECONCILE_INTERVAL_MS,
  passes?: Pick<PassBilling, 'reconcileRefunds'>,
) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = Promise.all([
      billing.reconcile().catch((error: unknown) => {
        console.error('Equipment payment reconciliation failed; retrying on the next interval', errorIdentifier(error));
      }),
      passes?.reconcileRefunds().catch((error: unknown) => {
        console.error('Day-pass refund reconciliation failed; retrying on the next interval', errorIdentifier(error));
      }),
    ]).then(() => { pending = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
