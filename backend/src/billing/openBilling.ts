// Rules for membership card billing that is still open: abandoned checkouts and the desk sales an
// open subscription or checkout must not overlap.

import type {Database} from '../db.js';
import {AppError} from '../domain.js';

/**
 * A checkout whose first Stripe call failed never stored a session ID, so nobody ever received its
 * payment link, and any session that call did create expired with Stripe's 24-hour default. After a
 * day such a row is abandoned: expire it so it stops blocking a new checkout, free membership or
 * desk sale.
 */
export async function expireAbandonedMembershipCheckouts(db:Database,userid:number) {
  await db.query(`UPDATE app_membership_billing SET status='expired' WHERE userid=$1 AND status='pending'
    AND checkout_id IS NULL AND subscription_id IS NULL AND created_at<now()-interval '24 hours'`,[userid]);
}

/**
 * Refuse a desk membership starting at `startsAt` while card billing could charge for the same
 * dates: an online checkout still in progress, or a subscription that has not confirmably stopped
 * renewing by then. Stripe would otherwise take a second payment for a period already sold.
 */
export async function assertNoCardBillingFrom(db:Database,userid:number,startsAt:string) {
  await expireAbandonedMembershipCheckouts(db,userid);
  const open=(await db.query<{status:string}>(`SELECT status FROM app_membership_billing WHERE userid=$1
    AND status NOT IN ('canceled','incomplete_expired','expired')
    AND NOT (cancellation_confirmed AND cancellation_effective_at<=$2::timestamptz) LIMIT 1`,[userid,startsAt])).rows[0];
  if(!open) return;
  throw new AppError(409,'CARD_BILLING_ACTIVE',open.status==='pending'
    ? 'This member has an online card checkout in progress. Ask them to finish or cancel it before selling a membership at the desk.'
    : 'This member pays monthly by card, and their next card renewal would charge for these dates too. Ask them to turn off automatic renewal, then start this membership when their card billing ends.');
}
