# Monthly studio rentals (SDTA-124)

## What this adds

`/studios` is a separate monthly-rental page, not another mode in hourly equipment booking. Members can compare all eight spaces in a month calendar, choose a one-month period, see the price/cancellation terms, hold the space, pay with staff, and cancel. A pending hold is **not** shown as a paid booking.

The inventory comes from the sponsor Q&A: three small, three medium and two large studios. No rates are invented. An administrator must enter the monthly USD price and explicitly confirm a cancellation policy before a studio can be booked. Existing rentals retain their quoted price and policy if an admin changes future terms.

The sponsor explicitly permits staff to mark payments manually initially and says card processing can come later. Staff with payment-update permission can record a payment already received, with a receipt reference. Members cannot self-confirm payments. Staff can also record a completed refund with an original-method reference. Both actions have an audit trail. The rental page shows these transactions separately from membership payments.

Optional Stripe **test-mode only** checkout is also implemented. It never accepts a live secret key and the success redirect never marks a booking paid. A verified, signed provider event (or server-to-server reconciliation) must match the rental, amount, currency and session before confirmation. No credentials or live provider verification are included in this PR.

## Sources and policy decisions

- [Requirements sheet](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit): B-001 monthly studios/hourly equipment; instructor reservation restriction; rental notifications.
- [Use cases](https://docs.google.com/document/d/1ivzrEd9E1mOIvG0llNb8ptt4l26qe7HpIP3UzzUibGM/edit): active monthly subscription, choose available space, payment/confirmation, cancellation/refund information.
- [Sponsor Q&A](https://docs.google.com/document/d/1kg8bFolDIC-LfMnr-E-P60TvwbNEBpkvcJRD-iSaW50/edit): 3/3/2 studio inventory; staff may manually mark payments initially; card processing may follow; cancellation timeframes not concrete.

**Provisional, explicitly visible:** a rental runs from its start date to the same date in the following month, clamped to that month's final day. The end date is exclusive. Dates and cancellation cutoff use `APP_TIME_ZONE` (default America/New_York), not the browser timezone. Example: January 31 → February 28, or February 29 in a leap year. This is an implementation choice awaiting sponsor approval, not a claimed requirement.

Admin cancellation options are `full_before_start` (full refund before the first rental day; none thereafter) and `no_refunds`. Neither is seeded as sponsor policy. An admin must confirm terms appropriate for the environment. No invented membership cancellation rule is applied to studios. More complex notice/proration rules require a future explicit policy choice.

Instructor accounts remain prohibited even when another role is present (conservative interpretation of the documented prohibition). RBAC policy changes can refine this separately.

## Set up locally

1. Run the normal additive migrations. Migration `011_studio_rentals.sql` creates separate tables and does not reset accounts, memberships, equipment reservations or payment records.
2. Sign in as admin, open **Studios**, expand **Configure studio**, set a rate and cancellation policy and confirm the terms. For demos use clearly identified sample terms; do not represent them as sponsor-approved rates.
3. Sign in as a monthly member and choose a date. Choose **Pay with staff**. A 31-minute hold is created; it expires if payment is not recorded.
4. In a separate staff/admin session, open Studios → **Staff payment desk** and record the actual receipt reference. Only then is the rental confirmed and its notification queued.
5. Cancel before the start date under a full-before-start policy. The space becomes available immediately; the payment remains `refund_pending` until the original-method refund is recorded. A cancellation is not falsely reported as a completed refund.

Staff records require `payment/update`; studio configuration is admin-only. The server reloads roles/access status for mutations. Active monthly subscription and instructor rules are enforced on the server, not only in the UI.

## Optional Stripe test setup

Backend only, ignored environment configuration:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_STUDIO_WEBHOOK_SECRET=whsec_...
APP_ORIGIN=http://localhost:5173
```

Configure the Stripe test webhook (or Stripe CLI forwarding) to `/api/webhooks/stripe-studios` for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `refund.created`, `refund.updated`, `refund.failed`

[Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment), [webhook signatures](https://docs.stripe.com/webhooks/signature), [idempotency](https://docs.stripe.com/api/idempotent_requests), [refunds](https://docs.stripe.com/api/refunds/create).

Only card Checkout is enabled, in test mode. Repeated checkout/refund requests use stable idempotency keys. Refund retries first look for an existing matching provider refund to reconcile a prior lost response. A confirmed failed/canceled provider refund requires staff reconciliation in Stripe; the application disables automatic retry of that terminal refund rather than replaying it indefinitely or risking a duplicate refund. A network failure with no confirmed provider refund remains retryable. Unrelated account Checkout events are acknowledged without modifying studios. The callback validates raw-body signatures and rejects live events. Event IDs are persisted atomically with the booking change. Out-of-order pending refund events cannot downgrade a completed refund.

**Do not release a Stripe hold just because a local timer elapsed.** An uncertain network response may conceal a completed payment. The member's **Resume / verify test checkout** action retrieves the real session, confirms paid sessions or expires an unpaid open session when safe. Provider expiration callbacks also release unpaid holds. If the original Checkout creation response was lost before its session ID was saved, the action retries with the same idempotency key. A hold that still cannot be reconciled remains blocked and explicitly needs staff/provider investigation rather than risking a double booking or second charge. Stripe config must remain available to manage existing test-card rentals.

## Correctness checks

- Database exclusion constraint protects overlapping pending/confirmed date ranges, even with simultaneous requests.
- Quoted price/policy revision checked before hold; quote is then immutable on the rental.
- Request UUID bound to member/date/studio/method and serialized for duplicate requests.
- Manual holds expire; late staff payment is rejected.
- Member ownership checked on viewing/cancelling/reconciling rentals.
- Payment and rental state differ; cancellation releases space while outstanding refunds remain visible.
- Notifications to the member and active staff/admins use the existing queue and honor all-email opt-outs. Confirmation only queues after payment, cancellation includes refund details, and completed refunds queue a separate notice.
- Application-specific audit table records booking, configuration, payment and refund transitions.

## Review boundary

This PR is implementable and demonstrable using the sponsor-approved manual-payment workflow without Stripe credentials. Real Stripe test-account Checkout, delivery of its webhook from the provider, and provider-issued refunds still need a controlled rehearsal once account credentials exist. Synthetic signed-event and adapter tests are not claimed as that rehearsal. Live charging, deployment and sponsor approval of actual rates/cancellation/month-boundary policy are intentionally not performed.
