/** First complete monthly billing boundary with at least 30 elapsed days' notice.
 * Preserve the original anchor day (Jan 31 -> Feb 28 -> Mar 31), not a 30-day month. */
export function cancellationBoundary(periodEnd:number,anchor:number,requestedAt:number):number {
 if(![periodEnd,anchor,requestedAt].every(Number.isSafeInteger)||periodEnd<=0||anchor<=0)
  throw new Error('Missing canonical monthly billing dates');
 const deadline=requestedAt+30*86400, base=new Date(anchor*1000);
 let boundary=periodEnd;
 for(let count=0;boundary<deadline&&count<24;count++) {
  const current=new Date(boundary*1000), month=current.getUTCMonth()+1;
  const last=new Date(Date.UTC(current.getUTCFullYear(),month+1,0)).getUTCDate();
  boundary=Date.UTC(current.getUTCFullYear(),month,Math.min(base.getUTCDate(),last),base.getUTCHours(),base.getUTCMinutes(),base.getUTCSeconds())/1000;
 }
 if(boundary<deadline) throw new Error('Invalid billing period');
 return boundary;
}
/** SQL: user_membership ids of card-paid periods that Stripe will renew. Turning off auto-renew in the
 * app sets a cancellation date on a later period boundary (Stripe cancel_at) and leaves
 * cancel_at_period_end false, so only a period ending before that date renews. */
export const AUTO_RENEWING_PERIODS=`SELECT i.membership_id FROM app_membership_invoice i JOIN app_membership_billing b ON b.id=i.billing_id
  WHERE b.status='active' AND NOT b.cancel_at_period_end AND (b.cancellation_effective_at IS NULL OR b.cancellation_effective_at>i.period_end)`;
