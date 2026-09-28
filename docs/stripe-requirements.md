# Stripe requirements — updated September 28, 2026

## Scope

PR #22 remains test-mode-only. This update is not merged or deployed to the public
RIT app. RBAC and studio dependencies were merged September 27. Payment analytics
(FR-070) are separate; this PR does not claim to implement the reporting dashboard.

## Requirements implemented

- SDTA-127 / FR-053: hosted one-time day-pass Checkout in addition to recurring
  memberships and studio Checkout. Only canonical paid provider state issues paid
  access. Server-owned prices, revisions, ownership, required waivers and dates
  are checked. Duplicate events cannot issue a second pass or receipt.
- B-003/B-004: configurable student rates and school-partner free access. Staff's
  existing Student classification supplies student eligibility; a checkbox in a
  checkout request does not. Admins configure each plan's approved student amount
  and whether partners receive free access. Staff record the approved school /
  verification reference and eligibility-through date. No rate or school list is
  invented by the app. An expired or insufficient eligibility period is rejected.
  Approved free memberships issue one month without Stripe or automatic renewal.
  Future purchases re-check eligibility; existing recurring agreements retain
  their accepted price snapshot rather than silently changing the charge.
- SDTA-129 / FR-057: monthly cancellation requires at least 30 elapsed days' notice,
  effective at the first full monthly billing boundary on/after that deadline.
  Month-end anchors are preserved. The purchase consent discloses this rule.
  The request/date is persisted before Stripe calls; retries reuse the same date
  and idempotency key. Requested vs provider-confirmed cancellation is visible.
  The customer portal permits payment-method maintenance, not plan changes or a
  shortcut around cancellation notice. No partial-month amount is invented.
- SDTA-129 / FR-058: day-pass cancellation deadline is midnight at the start of the
  visit date minus three calendar days, in the studio timezone. Checkout sessions
  that have not been paid may simply expire. Timely paid online cancellations
  refund the original PaymentIntent; pending refunds are not labeled successful.
  Timely manual cash/card pass cancellations stop the pass, but the ledger remains
  paid until staff actually returns and records the money. Late requests fail
  without changing access/payment state. Existing studio refund policy is unchanged.
- SDTA-148: invalid webhook signatures return 400 and insert a timestamped
  `stripe.invalid_signature` security event. Bodies, signature headers, credentials
  and card data are never stored in this log. Signature validation precedes all
  payment updates. Other products' checkout events are ignored by the pass handler.
- SDTA-130 / FR-031/034/054/055: staff cash/external-card recording and receipts
  are retained and regression-tested. Receipts include method and reference;
  changes retain staff/time audit evidence. Manual refunds must preserve the
  original method. Provider-managed membership/pass payments cannot be relabeled
  through the generic staff payment endpoint. Recording manual payment/refund
  does not execute a card transaction.

Source: [project requirements](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit).

## Configuration and UI

1. Apply additive migrations 012 and 013 before deploying matching code. Do not
   edit already-applied migrations or enroll existing accounts in automatic billing.
2. Configure `STRIPE_TEST_SECRET_KEY` (`sk_test_` or scoped `rk_test_`),
   `STRIPE_STUDIO_WEBHOOK_SECRET`, and the exact HTTPS `APP_ORIGIN`. Live keys and
   events remain rejected. Secrets do not belong in Git.
3. In Staff Plans, configure approved student prices (blank = standard rate),
   school-partner free-plan flags, and a verification reference/expiry for each
   eligible member. A past expiry revokes eligibility for future claims.
4. Members use Membership & passes for monthly Checkout, a dated day pass,
   eligible free access, payment-method changes and cancellations.
5. Cash/manual-card refunds must be completed outside the app against the original
   payment method, then recorded by staff. The app never claims cash moved itself.

The shared signed raw-body webhook is `POST /api/webhooks/stripe-studios`.
Events: `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
`invoice.payment_failed`, `invoice.upcoming`, `refund.created`, `refund.updated`,
`refund.failed`. Restricted credentials also need portal-configuration creation
permission for the application-owned payment-method-only portal.

## Verification evidence

Earlier September 28 real sandbox rehearsal: membership and studio hosted Checkout,
actual signed delivery, monthly renewal, declined renewal/recovery, cancellation,
original-card refunds, customer portal card replacement, restart persistence, and
14 receipts/notices received in controlled temporary inboxes. No live charges.

This update adds actual PostgreSQL tests for day-pass issuance/refund, self-asserted
eligibility rejection, staff-only pricing, price revisions, student rates, partner
expiry, free membership, waiver gating, manual cancellation, three-day notice,
30-day monthly boundaries/retries, portal restrictions and forged-webhook logging.
Staff cash/card receipt/refund tests verify ledger and actor/time audit records.
UI tests check date selection, effective price, consent and non-recurring free access.
These automated provider mocks are not labeled real card transactions.

New real Stripe API checks passed: creation of a server-priced discounted day-pass
Checkout, expiration of that unpaid Checkout, actual monthly cancellation scheduled
at least 30 days ahead with identical retry, and a payment-method-only portal
configuration/session. Test subscription cancelled after the check. This API smoke
run did not complete a paid day-pass browser checkout; that path has database/mocked
provider regression coverage, distinct from the earlier membership/studio rehearsal.

### Final automated result

- Full regression run: 79 backend integration, 5 frontend/API integration,
  32 backend unit and 16 frontend unit tests passed; both builds passed.
- After the final refund-ordering fix, all 27 affected membership/day-pass/studio
  integration tests passed, including one new early-refund regression. This brings
  distinct covered tests to 133 (not counting repeated executions as extra tests).
- New real-provider smoke checks: four passed; no live payments/public deployment.

## Deployment and rollback

Review PR #22 and use permanent sandbox webhook routing before offering Checkout.
Back up the DB, apply migrations, then release frontend/backend together. This
change does not enable live payments or approve real prices. Retain the old image
and config; disable new checkout and reconcile in-flight events if rolling back.
Never drop payment, eligibility or audit records as a rollback.

References: [subscription update](https://docs.stripe.com/api/subscriptions/update),
[portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create).
