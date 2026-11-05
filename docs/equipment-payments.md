# Equipment reservation payments

Equipment reservations now use the configured machine's hourly rate multiplied
by the selected whole hours. A $7 hourly rate costs $7 for one hour and $14 for
two hours. The backend calculates integer cents from the database rate; the
browser's total is checked for stale pricing and cannot override the charge.

The reservation form shows the total and opens hosted Stripe Checkout. Paid
equipment is held as `pending` for a 31-minute checkout window. Only a matching
canonical Stripe session with `status=complete` and `payment_status=paid` confirms
the reservation, creates its payment record, and queues its confirmation and
receipt. The return URL itself never confirms payment. Signed webhooks and reads
of the member's reservations reconcile payment; repeated callbacks cannot create
another payment or confirmation. This follows Stripe's
[Checkout fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

An unfinished checkout can be resumed or cancelled from My reservations. An
expired unpaid Stripe session releases the equipment slot. Provider outages and
ambiguous creation responses retain the hold until the original session can be
verified; retry uses the same Stripe idempotency key and quoted rate/name.
Unresolved creation attempts older than 23 hours require staff reconciliation.
Paid bookings must start at least 30 minutes in the future to allow checkout.
An explicitly configured $0 rate confirms without payment; a missing rate blocks
booking. Existing reservations retain their status and history.

## Setup

This uses the application's existing **Stripe test mode** configuration. It does
not enable live keys or live charges.

1. Apply additive migration `035_equipment_checkout.sql` with
   `npm run migrate --prefix backend` against the intended database before
   releasing the code.
2. Configure backend `STRIPE_TEST_SECRET_KEY`,
   `STRIPE_STUDIO_WEBHOOK_SECRET`, and `APP_ORIGIN` as documented in
   [studio rentals](studio-rentals.md). Never use a `VITE_` prefix for secrets.
3. Route these events to `POST /api/webhooks/stripe-studios`:
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`, and
   `checkout.session.async_payment_failed`. Keep the existing membership/pass
   event subscriptions too.
4. For local development, put the two Stripe settings in root `.env.local`
   (see `.env.example`). Both `npm run dev` and `npm run dev:email` read them
   for the backend. The launcher supplies `http://localhost:5173` as the return
   origin and does not pass Stripe secrets to the frontend process. For local
   callbacks, run
   `stripe listen --forward-to localhost:8080/api/webhooks/stripe-studios`
   and use its signing secret.

If Stripe is unconfigured, paid equipment booking fails with an explicit error
and does not create a confirmed booking. Cancellation retains the existing
24-hour notice rule. Cancelling a paid reservation does not automatically refund
it; contact staff. Changes to checkout-backed bookings are blocked until payment
is reconciled, so a staff edit cannot confirm an unpaid hold or silently change
the purchased hours or machine. Automatic equipment refunds and a staff
reconciliation UI are outside this change.

For machines configured to require waivers, all current required agreements must
be signed and approved, with any expiration covering the whole reserved session.
The same waiver and certification checks run before creating or resuming Checkout,
on an idempotent reservation retry, and before payment confirms the booking. Staff
booking for someone else uses that member's requirements. An unpaid or paid hold
whose waiver was revoked stays unconfirmed; after valid signing, the original
paid session can reconcile without another charge. The equipment page disables
payment and links to waivers/certifications when eligibility is missing. Machine
requirements are unchanged: CNCs and lathes require waivers; laser engravers keep
their existing configured requirement.

## Verification

`backend/test/integration/equipment-payments.test.ts` uses a disposable PostgreSQL
database with mocked Stripe API responses, including signed webhook requests.
It covers hourly totals, unpaid/paid gating, amount/identity mismatch rejection,
duplicate and stale callbacks, expiry and cancellation, ownership, missed
webhooks, missing configuration/rates, free equipment, lost-response retries,
and definitive creation failures. Frontend tests check the displayed total,
redirect before confirmation, pending return state, and checkout cancellation.
These tests do not claim an actual Stripe card transaction or deployment.

`backend/test/integration/equipment-waivers.test.ts` also checks missing,
unapproved, expired and superseded waivers, expiration before the booking ends,
staff-assisted checkout, resume/retry enforcement, certification requirements,
and payment reconciliation after waiver approval is restored.
