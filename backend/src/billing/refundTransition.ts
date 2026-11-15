import type Stripe from 'stripe';
import { AppError } from '../domain.js';

/** What the app has already recorded for an original-card refund. */
export interface RecordedRefund {
  refundId: string | null;
  refundStatus: string | null;
}
/** The Stripe refund being applied. */
export interface IncomingRefund {
  id: string;
  status: string | null;
  /** Set on retries by refundAttempt: the failed attempt this one replaces. */
  metadata?: Record<string, string> | null;
}

const failedStatuses = ['failed', 'canceled'];

/**
 * Decides whether a Stripe refund update should be applied to a recorded refund.
 * Shared by day-pass and membership refunds so their stale/out-of-order event
 * handling stays identical:
 * - after a success, only that same refund failing later may change anything;
 * - a repeat of the recorded status is a no-op;
 * - a late `pending` event never reopens a refund already recorded as failed.
 */
export function refundTransition(current: RecordedRefund, refund: IncomingRefund): 'skip' | 'apply' {
  const failed = failedStatuses.includes(refund.status ?? '');
  if (current.refundStatus === 'succeeded' && !(current.refundId === refund.id && failed)) return 'skip';
  if (current.refundId === refund.id && (current.refundStatus === refund.status || failedStatuses.includes(current.refundStatus ?? '') && refund.status === 'pending')) return 'skip';
  return 'apply';
}

/** A refund that returned nothing: failed or canceled. */
export const failedRefund = (refund: Pick<Stripe.Refund, 'status'>) => failedStatuses.includes(refund.status ?? '');

/**
 * The live (pending or succeeded) original-card refund on a payment, if any. A failed or canceled
 * attempt returned nothing, so it is not one: a retry may submit a new refund. Partial, multiple or
 * mismatched live refunds still need staff reconciliation.
 */
export function liveRefund(list: Stripe.ApiList<Stripe.Refund>, amount: number) {
  const live = list.data.filter((refund) => !failedRefund(refund));
  if (list.has_more || live.length > 1 || live.some((refund) => refund.amount !== amount || refund.currency !== 'usd'))
    throw new AppError(409, 'RECONCILE_REQUIRED', 'Existing refunds require staff reconciliation.');
  return live[0];
}

/**
 * A new refund attempt's idempotency key and metadata. A retry names the failed attempt it replaces
 * (Stripe lists newest first): in the key, so a repeated click reuses that attempt instead of refunding
 * twice; and in metadata, which every later update of the refund carries, so its failure can be told
 * from a late failure of the attempt it replaced (see replacedAttemptFailed).
 */
export function refundAttempt(base: string, list: Stripe.ApiList<Stripe.Refund>) {
  const replaces = list.data.find(failedRefund)?.id;
  return replaces ? { key: `${base}:${replaces}`, metadata: { replaces } } : { key: base, metadata: undefined };
}

/**
 * A failure of a refund other than the recorded one is a late report about an attempt a retry has
 * since replaced, and says nothing about the current refund — unless it is the retry itself, whose
 * metadata names the recorded attempt it replaced. Differing IDs alone don't say which is newer.
 */
export const replacedAttemptFailed = (current: RecordedRefund, refund: IncomingRefund) =>
  failedStatuses.includes(refund.status ?? '') && !!current.refundId && current.refundId !== refund.id &&
  refund.metadata?.replaces !== current.refundId;
