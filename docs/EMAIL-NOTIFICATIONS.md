# Brevo notifications — implementation and review guide

This change replaces the planned SendGrid integration with Brevo. It is a PR for
Matt to review, **not a deployed or live-delivery-verified feature**.

## Confirmed decisions (2026-09-17)

- Sender/reply-to: `arborcollaboratory@yahoo.com`.
- Footer: `1449 Wiseburg Road, White Hall, Maryland 21161`.
- Every user may disable **all** notification emails, including queued notices.
- Reminder scheduling uses the user's IANA time zone, editable in Profile.
- The 98% target means automated provider acceptance **on time**, not inbox delivery.
- Brevo replaces SendGrid. Account handoff is deferred until project completion.
- Retain the architecture's `The Crafty Studio` display name, configurable by env.

## Architecture

Business transactions write an outbox row in the same PostgreSQL transaction as
the business change. HTTP requests do not wait for Brevo. A worker claims pending
rows with database locks/leases, rechecks active user/opt-out/source validity, then
calls the provider. Unique event keys prevent repeated actions/scans from adding
duplicate notices. Templates render escaped HTML and plain text with identities,
address and a Profile preferences link. A signed-waiver event keeps the accepted
text/version, signer's name and recorded signing time in its immutable payload.

Apply additive migration `006_notifications.sql` through the existing migration
runner before running the updated server. Existing users default to notifications
enabled and `America/New_York` until they set their time zone. Existing waiver
records get **no invented expiration date**; their new `expires_at` stays NULL.
New registrations capture the browser time zone; changing Profile's time zone
reschedules pending, not-yet-attempted reminders.

### Runtime and safe defaults

Real sending is disabled unless `EMAIL_ENABLED=true`. It is rejected when
`ENABLE_DEMO_LOGIN=true`; the existing synthetic Docker demo remains email-off.
Supply these variables to the backend environment only (never commit API keys):

```text
EMAIL_ENABLED=true
BREVO_API_KEY=<provided privately at runtime>
APP_ORIGIN=https://your-real-application-origin
ENABLE_DEMO_LOGIN=false
EMAIL_FROM=arborcollaboratory@yahoo.com
EMAIL_REPLY_TO=arborcollaboratory@yahoo.com
EMAIL_FROM_NAME=The Crafty Studio
EMAIL_POSTAL_ADDRESS=1449 Wiseburg Road, White Hall, Maryland 21161
EMAIL_WORKER_INTERVAL_MS=60000
```

The worker scans expiration sources at startup and daily, and dispatches every
minute by default. It schedules at 09:00 in the user's zone **eight calendar days**
before expiration, leaving retry time before the strict seven-elapsed-day deadline.
09:00/eight days and the five-minute immediate-event target are implementation
defaults, **not stated requirements**. Newly discovered short-notice expirations
cannot retroactively meet the seven-day requirement and must not count as on-time.

Explicit rate-limit rejection retries with bounded backoff. Timeout/network/5xx or
expired in-flight leases are `uncertain`, not automatically replayed: the provider
may already have accepted the message. Check Brevo logs before manual recovery.
Do not claim exactly-once delivery across HTTP failures.

### On-time metric

`notificationMetrics(db)` reports eligible deadline-passed notices and those with
provider acceptance at/before the deadline. The percentage is `100 * on_time /
eligible`; an empty denominator reports no measurement, not 100%. Notices suppressed
or genuinely superseded before their deadline are excluded. Opting out or changing
a source after a missed deadline does not erase the miss. Pending/failed/uncertain late notices are
not successes. Brevo acceptance does **not** prove inbox delivery. Delivery-event
storage is separate; external webhook authentication/ingestion is not wired in this
PR, so bounce/delivery telemetry is not yet live.

## Coverage and boundaries for review

Wired existing flows: account created, newly signed waiver with copy, equipment
reservation and cancellation, staff-issued membership/day pass and payment records,
payment status/refund changes. Preferences have authenticated GET/PATCH endpoints
at `/api/me/notifications`; PATCH retains normal CSRF protection.

Scheduler supports certification renewal/end dates, explicit waiver expiration,
and membership expiration. Membership expiry is not an auto-renewal charge;
automatic billing/renewal workflows are absent and must not be implied by the email.

Templates also cover documented but not yet implemented sources: studio booking/
cancellation, transaction and account-creation failure, system issues/restoration,
account closure, certification changes and role changes. A template alone does not
mean that event is wired. Account-creation failures may have no persisted user to
target; no unsolicited notice is sent to arbitrary failed-registration addresses.

The live **Create an Account use case does specify a confirmation link**, timeout,
resend/change-email and login from that link. This is separate unfinished auth work;
this PR preserves the current registration/login contract and sends an account-
created notification, **not a verification link**. Matt should review that scope
explicitly. Signed-copy profile downloads and an administrative waiver-expiry editor
also remain separate work.

## Requirement traceability / tracking updates

- SDTA-139 foundation: FR-013–017 (all user types, subject, postal address,
  sender/recipient and opt-out), NFR-002/003.
- SDTA-140 templates: FR-027/028/030–034/063–068; distinguish wired sources above.
- SDTA-141 scheduling: FR-045, BR-010 (one week), BR-009 (98% as clarified).
  FR-056 auto-renewal notification remains dependent on an auto-renewal source.
- SDTA-142: saved ticket's mandatory waiver/payment-notice exceptions conflict
  with the owner's newer all-notifications opt-out instruction. The newer decision
  is implemented; update that ticket's acceptance text accordingly.

Live source documents checked before coding:
- [Requirements](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit)
- [Architecture](https://docs.google.com/document/d/1CeyE5pD_pmIZr6uXAO0zj9VhvVfYmsID3w42Trb4ly4/edit)
- [Use cases](https://docs.google.com/document/d/1ivzrEd9E1mOIvG0llNb8ptt4l26qe7HpIP3UzzUibGM/edit)

The shared Drive/Jira documents have not been edited by this PR. This file records
the exact provider/policy corrections for review rather than claiming an external
documentation update happened.

## Before enabling delivery after review

The signed-in Brevo account currently shows its SMTP/API Configuration → Verification
onboarding screen; this is not evidence of a verified sender or completed activation.
Verify Brevo sender/transactional activation, supply a real reachable app origin
and backend-only key, configure an appropriate controlled recipient for a real
delivery smoke test, and decide which pre-enable queued notices are still relevant.
Do not enable delivery against synthetic/demo recipients. Test inbox delivery and
sender rendering explicitly; unit mocks and a passing build do not establish them.
