# Payment follow-up and real sandbox acceptance — October 26, 2026

## Changes

- Day-pass checkout and free memberships reuse `AccessService.assertWaivers`.
  Missing, retired, future-only and optional-only policies fail closed with
  `WAIVERS_NOT_CONFIGURED` (409); unsigned or expired required signatures return
  `WAIVER_REQUIRED` (403). These decisions occur before financial writes or
  provider calls. Existing current signed-policy success paths remain covered.
- Membership, day-pass and studio Checkout explicitly request card payments.
  This prevents Stripe's account-level dynamic defaults from offering Klarna or
  other buy-now-pay-later methods. The browser rehearsal initially exposed those
  defaults; the completed transaction used the corrected card-only session.
- No schema changes, bulk data updates, live keys or live-charge enablement.

## Real provider/browser rehearsal

Dedicated local PostgreSQL database, synthetic member, nonbinding fixture policy,
patched application and temporary HTTPS webhook were used. Nothing was signed
for a real member and no production entitlement was created.

1. The application created a server-priced **$25 USD** day-pass session.
2. Hosted Stripe Checkout displayed **Sandbox**, accepted the standard Stripe
   test card, and returned to the application. Canonical provider state was
   `complete` / `paid`, `livemode=false`, `payment_method_types=['card']`.
3. Actual Stripe delivery of `checkout.session.completed` created exactly one
   pass, one paid $25 payment and one receipt outbox item in the isolated DB.
4. The existing public RIT endpoint also recorded that exact real provider event
   through its signature-verified route. The synthetic checkout was unknown to
   that DB, so it issued **zero** public test entitlements.
5. Timely member cancellation created a successful full original-payment refund.
   Repeating cancellation left exactly one provider refund. The pass became
   cancelled and the payment became refunded.
6. Real `refund.created` and `refund.updated` events reached both applications.
   Their provider `pending_webhooks` counts were zero after retiring the obsolete
   endpoint. Earlier checkout events retain a historical pending retry count.
7. Eight locally re-signed replays of the four actual provider events returned
   200 without additional passes, payments, refunds or receipt outbox items.
   An unsigned event returned 400. Replays are distinguished from actual provider
   deliveries in the evidence.

The public app's replacement endpoint secret was checked against the running
public configuration. An older sandbox endpoint pointed at the same public URL
with a different endpoint-specific secret; it was disabled, not deleted. The
current replacement stayed enabled. The temporary acceptance endpoint is disabled
after verification. Test infrastructure and evidence are retained locally.

**Email limit:** this run verified one queued receipt and one queued refund notice;
outbound email was disabled in the isolated app. It does not claim current inbox
delivery. The earlier September rehearsal's received emails are separate evidence.

## Source-backed configuration candidates

The sponsor's [Initial Pricing Model](https://docs.google.com/document/d/1tyMohFSeVPGw3k9xhLnlmBcPBRjAyuhWvPfTocAWdKM/edit)
specifies **$95 monthly membership** and **$25 day pass**. Those values were used
in the isolated app. [Inactive plan candidates](hosting/payment-plan-candidates.json)
are staged for review, not silently applied over the public site's six existing
placeholder plans. Existing accepted price snapshots must remain unchanged.
Do not create duplicate plans if the pricing PR has already configured them.

Unresolved configuration decisions:

- The sponsor's preliminary business rules do not give a student discount amount
  or an approved school-partner list. Do not invent either or self-verify members.
- The [supplied equipment waiver](https://docs.google.com/document/d/1Q_mVgZ9hvta5YSo1bPATCucYHaUPqd6B/edit)
  explicitly calls for legal review before use. No final approval was established,
  so the draft was not published as an approved required policy.
- The [Preliminary Business Rules](https://docs.google.com/document/d/1Fu5lBrNfX6YNXvxOmyc_rPb285VRZEFS/edit)
  say memberships may cancel anytime to stop future renewal, whereas the older
  requirements and current implementation require 30 days' notice. This test
  does not silently choose a new cancellation contract or rewrite existing ones.
- Tax treatment is marked for accounting determination in those rules.

These are sponsor/configuration decisions, not failed Stripe API calls. Public
rollout also remains subject to the existing migration/deployment guard; this
task did not merge, deploy code, apply production migrations or enable live money.

## Automated verification

- Backend build and **38 unit tests** passed.
- Full backend PostgreSQL integration suite: **137/137** passed, including six
  new fail-closed policy scenarios. Focused payment subset: **46/46** passed.
- Frontend build passed; this patch does not modify frontend behavior.
- An earlier local full run and isolated rerun hit an unrelated empty HTTP 502
  in the NFC authorization-matrix test. The unchanged matrix passed in the final
  full run. This transient result is retained in local logs, not hidden or counted
  as a payment regression fix.

Local evidence: `iste501/stripe-acceptance-20261026/` (outside the repository).
Private keys, login material, full provider payloads and temporary webhook secrets
are excluded from Git. Sanitized provider receipts, canonical refund, replay
results and final SQL counts are retained with the report.
