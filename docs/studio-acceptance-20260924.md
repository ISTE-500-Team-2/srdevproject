# SDTA-124 acceptance evidence — 2026-09-24

## Integration and source

Live Jira SDTA-124 was read September 24 (due September 25). This PR is stacked on `feat/rbac-completion`, including its integration of current demo fixes. No production migrations, charges or emails were performed.

## Acceptance mapping

| Ticket requirement | Implementation and evidence |
| --- | --- |
| Monthly or hourly studio reservations | Implemented monthly studios. The same ticket explicitly distinguishes B-001 monthly studios from BR-002 hourly equipment, so hourly studio booking is not claimed. Date boundary policy is provisional and visible in `studio-rentals.md`. |
| Booking/cancellation confirmations | Confirmation queues only after payment, not on hold creation. New integration test checks member/staff recipients, opt-out suppression, duplicate cancellation deduplication, and refund instructions. Existing sender infrastructure is reused; this run did not send real inbox messages. |
| Calendar availability across all spaces | Separate Studios page lists the 3 small/3 medium/2 large inventory and month availability. Browser verified administrator configuration, member date selection and booking; integration tests cover overlap/conflict prevention. |
| Linked FR-029 separate admin display | Admin configuration and staff payment desk are separate from member booking controls, with server-side authorization. The linked sheet's FR-029 is admin display, not a booking-email requirement. |
| Linked FR-030 cancellation confirmation | Member cancellation transitions rental state and queues confirmation including pending-refund instructions; refund completion is a separate state and notification. |

## Verification

- Full combined suites before the new notification test: 60 backend integration, 30 backend unit, 5 frontend integration, 10 frontend unit = **105 tests**; both builds passed.
- Expanded studio integration file: **9/9 passed**, including new recipient/dedup/opt-out case (suite inventory now 106 tests; not claiming a second full run).
- Existing tests cover simultaneous overlapping requests, ownership, instructor/permission restrictions, stale quotes, expired manual holds, signed synthetic payment events, replay and refund reconciliation.
- Real browser with the actual integrated backend and isolated PostgreSQL: administrator configures clearly labeled test rate/terms; monthly member creates unpaid hold; staff records a receipt; member sees confirmed rental; member cancels; staff records completed original-method refund; UI shows refunded. No mocked API responses were used.
- Database-backed role revocation/migration tests also pass in the stacked code.

## Not yet production-complete

Actual sponsor rates, cancellation policy and month-boundary convention require confirmation. Test values are not sponsor-approved prices. Manual payment/refund recording documents transactions performed elsewhere; it does not move money. Real Stripe test-account Checkout, provider-delivered webhook and provider-issued refund have not been exercised. Synthetic adapter/signature tests are not substitutes. Stripe setup follows this task. Current UI header overlap and unrelated waiver/branding defects remain known.

## Deployment and rollback

Review and integrate RBAC first, then this stacked PR. Apply additive migrations 010/011 with a database backup, preserve email/runtime settings, configure approved rental terms explicitly, then verify member and staff authorization on the deployed environment. Keep prior application image for rollback; do not delete rental/payment/audit records or reverse schema blindly. This task did not merge or deploy either PR.
