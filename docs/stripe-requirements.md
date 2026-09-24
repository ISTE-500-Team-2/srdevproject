# Stripe requirements and verification — 2026-09-24

## Scope and release status

This branch extends PR #15 (studio rentals), which depends on PR #14 (RBAC).
It is test-mode-only and is not deployed. Local provider mocks are not evidence
of a successful Stripe transaction. Do not mark the payment requirements Done
until the real sandbox rehearsal below passes. No Claude Code execution is needed.

The requirements distinguish monthly studio rentals (one-time Checkout payment)
from monthly recurring memberships (subscription Checkout). A separate workflow
for sending invoices to collect payment is not established by the requirements.
Stripe-generated subscription invoices are used as payment evidence internally.

## Requirement traceability

- B-021 / FR-007: monthly subscription Checkout with explicit recurring-charge
  consent, server-authoritative monthly plan/revision/price, and stop-renewal action.
  Only a validated paid invoice issues a membership period. Failed renewal never
  extends access. Covered locally; real renewal/failure tests remain outstanding.
- FR-025: billing plan, amount, status, period end and renewal state shown to the
  member. Existing membership records remain the entitlement source; legacy
  active memberships cannot silently be replaced or enrolled in auto-renewal.
- FR-031: separate deduplicated receipt notifications for paid membership invoices
  and studio payments (including staff-recorded studio payments). Queue assertions
  pass locally; real delivery for these new templates/flows remains unverified.
- B-020 / FR-034: staff-authorized full membership refund uses the invoice's original
  PaymentIntent, never an arbitrary destination. Pending refunds are not labeled
  refunded. Provider-confirmed success changes the ledger and queues confirmation.
  Studio cancellation/refund policy remains the existing PR #15 implementation.
  Partial/multiple membership refunds require reconciliation rather than guessing.
- FR-053: hosted test Checkout for studio and membership payments. No card numbers
  enter the app. No real account payment has been completed in this branch.
- FR-054 / FR-055: existing staff cash/external-card recording is retained. Recording
  an external payment does not charge a card. Stripe-managed membership entries
  cannot be manually relabeled paid/refunded through the generic staff endpoint.
- FR-056: invoice.upcoming queues a deduplicated renewal notice; the provider's
  upcoming-invoice schedule needs account-level configuration and verification.
- FR-070: payment analytics are NOT completed by this change. Payment ledgers gain
  recurring membership entries, but reporting/dashboard acceptance remains separate.

Source: project requirements spreadsheet
https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit

## Design and safety

Migration 012 is additive: billing records, invoice-to-membership/payment mappings,
and webhook deduplication. Existing accounts are not enrolled automatically.
Checkout retries reuse a server-owned idempotency key. Ambiguous old requests
require reconciliation. Subscription event handling retrieves canonical provider
state under a per-subscription lock, including cancellation, so concurrent/late
notifications do not re-enable renewal. Duplicate invoices cannot issue duplicate
membership periods. Unexpected amounts, currency, customers, periods or overlapping
entitlements fail closed for staff reconciliation.

Refunds do not implicitly cancel future billing or revoke the already-paid access
period. These are separate actions, pending approved business policy. No sponsor
rates or cancellation rules are invented here; test fixtures are not pricing approval.

## Test environment setup (no secrets in Git)

Set STRIPE_TEST_SECRET_KEY to a protected sk_test_ or appropriately scoped rk_test_
credential, STRIPE_STUDIO_WEBHOOK_SECRET to the signing secret, and APP_ORIGIN to
the exact HTTPS application origin. Live keys/events are rejected. Read-only MCP
OAuth does not configure the application API key or its webhook secret.

The shared raw-body/signature-verified endpoint is:
POST /api/webhooks/stripe-studios

Subscribe to the studio events already documented in PR #15, plus:
checkout.session.completed, checkout.session.expired,
customer.subscription.created, customer.subscription.updated,
customer.subscription.deleted, invoice.paid, invoice.payment_failed,
invoice.upcoming, refund.created, refund.updated, refund.failed.

Configure the sandbox customer portal for payment-method maintenance. Do not enable
unsupported plan swaps/proration/discounts: this implementation deliberately accepts
one fixed monthly USD line with the exact agreed amount. Configure upcoming-invoice
notifications and verify timing. Confirm restricted-key permissions for Checkout,
subscriptions, invoices/invoice payments, refunds and portal sessions.

## Required real-provider rehearsal before release

1. Obtain rotated usable sandbox credentials through protected configuration;
   the previous exposed secret must not be reused. Protected entry has not arrived.
2. Create a disposable paid monthly test plan and isolated test member; explicitly
   consent and complete hosted Checkout. Confirm return alone grants no membership.
3. Deliver a signed webhook; confirm exactly one paid period, payment and receipt.
4. Replay and reorder events; verify no duplicate access or emails. Reject bad signatures.
5. Use test clocks for monthly renewal, decline/recovery, stopping renewal, and
   terminal cancellation. Verify access ends with the last paid period.
6. Exercise portal payment-method change and renewal notices with a controlled inbox.
7. Exercise staff refund, pending/success/failure and webhook retries. Confirm original
   card destination, ledger state and one refund confirmation; test member denial.
8. Rehearse one-time studio Checkout/webhook/refund with the same account/config.
9. Verify actual email receipt rendering/delivery and restart persistence on the
   target deployment. No production/member emails during isolated testing.

## Deployment and rollback

Review/merge dependencies #14 then #15 before this branch. Back up the target DB;
apply additive migration 012 and deploy the matching backend/frontend together.
Configure webhook routing before offering Checkout. Keep real payments disabled.
Retain prior image/config for rollback. If a problem occurs, disable new checkout
and reconcile in-flight provider events; never drop billing tables or financial
history as a rollback. Do not reuse the compromised Pi for billing credentials.

Official implementation references:
https://docs.stripe.com/billing/subscriptions/webhooks
https://docs.stripe.com/receipts
