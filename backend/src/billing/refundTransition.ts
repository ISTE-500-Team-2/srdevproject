/** What the app has already recorded for an original-card refund. */
export interface RecordedRefund {
  refundId: string | null;
  refundStatus: string | null;
}
/** The Stripe refund being applied. */
export interface IncomingRefund {
  id: string;
  status: string | null;
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
