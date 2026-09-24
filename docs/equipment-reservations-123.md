# SDTA-123 — hourly equipment reservations

Ticket: https://teamarbor.atlassian.net/browse/SDTA-123
Owner/reviewer: Matt Marana. Due September 25, 2026.

## Scope and acceptance evidence

- Hourly scheduling: existing equipment/date-time picker retained; durations now
  cover 1–24 whole hours in both UI and API. Explicit timezone parsing remains.
- Membership is not a reservation: existing entitlement/certification/waiver and
  equipment checks remain mandatory; booking creates a persisted reservation.
- Cooldown at most one hour: preserve zero-minute cooldown (adjacent half-open
  intervals allowed). No new one-hour buffer invented. Existing concurrent
  overlapping-request tests and database protection are retained.
- One-day cancellation notice: cancellation requires >=24 elapsed hours before
  start, enforced atomically in SQL. UI hides unavailable cancellation actions and
  states the rule. Too-late API requests return CANCELLATION_NOTICE_REQUIRED and
  do not alter the reservation or enqueue a cancellation confirmation.
- Staff/admin on-behalf booking: optional member ID in booking form/API. Server
  requires staff/admin role AND global create permission for another owner. The
  recipient's access, entitlement, training and waivers are checked, not staff's.
  Reservation ownership and confirmation notification belong to the recipient.
  Instructor actor prohibition remains unchanged.
- Actor/recipient audit: successful booking and member cancellation create audit
  records in the same transaction as reservation and notification changes.

## API compatibility

POST /api/reservations accepts optional userId; omitted means the signed-in user.
A member supplying another person's ID receives 403. Staff selecting themselves
still undergoes the normal eligibility rules. Existing authenticated/CSRF route
middleware remains. There is no new privileged cancellation override.
GET /api/reservations stays owner-scoped: bookings made for someone else appear
in THAT member's list, not the staff account's personal list. Staff receives the
booking result/recipient ID and the audit records retain attribution.

## Tests and integration

Added PostgreSQL tests for real staff on-behalf booking, recipient notification
and actor audit, owner spoofing, missing recipient entitlement/suspension, hourly
validation, late cancellation and exact inclusive 24-hour boundary. Existing tests
cover persistence/restart, overlap concurrency, adjacent bookings, membership,
certification and waivers. Added React→Express→PostgreSQL test for staff booking
four hours for a member and preserving owner-scoped lists.

This branch is based on PR14 (feat/rbac-completion), not Stripe PR22. It does not
require unmerged studio/Stripe features or a new migration. Reuse Edwin's conflict
work and coordinate this existing equipment page with Declan's tab rather than
introducing a second reservation system. No claim about SDTA-201 completion.

## Review/deployment

Review and merge RBAC dependency first, then retarget/merge this PR. Deploy matching
frontend/backend and verify actual RIT member/staff flows. Local tests do not mean
it is deployed. No payment collection, email sending, production data edits, new
rates or new cooldown policy were introduced. Existing notification worker sends
queued messages in configured environments; tests use isolated databases only.
Rollback: restore previous application image (no migration to undo), noting that
the older backend does not enforce the new 24-hour cancellation cutoff.
