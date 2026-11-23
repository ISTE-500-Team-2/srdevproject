// Caps how many database transactions may wait on Stripe at the same time.

import type {Pool, PoolClient} from 'pg';
import {transaction} from '../db.js';
import {AppError} from '../domain.js';

/**
 * A small counting semaphore. Work beyond `limit` waits in memory, holding nothing, and gives up
 * with PAYMENTS_BUSY after `waitMs` so a long Stripe slowdown cannot queue requests forever.
 */
export class ProviderGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number, readonly waitMs: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(wake);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new AppError(503, 'PAYMENTS_BUSY', 'Card payments are busy right now. Try again in a moment.'));
      }, this.waitMs);
      this.waiting.push(wake);
    });
    try {
      return await work();
    } finally {
      // Hand the slot straight to the next waiter, or give it back.
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

const gates = new WeakMap<Pool, ProviderGate>();
/** A third of the pool (at least one connection), so slow Stripe calls always leave the rest of the site connections. */
export function providerGate(pool: Pool) {
  let gate = gates.get(pool);
  if (!gate) gates.set(pool, gate = new ProviderGate(Math.max(1, Math.floor((pool.options?.max ?? 10) / 3)), 15_000));
  return gate;
}

/**
 * A transaction that calls Stripe while it holds its connection and locks (webhooks, refunds,
 * cancellations). Those reads stay inside the lock so out-of-order provider state can't win, so
 * instead of moving them out, cap how many such transactions run at once: a slow Stripe can then
 * hold only a few pooled connections, never all of them.
 */
export function providerTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  return providerGate(pool).run(() => transaction(pool, work));
}
