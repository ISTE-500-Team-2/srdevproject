# Brevo notifications — implementation and review guide

This change replaces the planned SendGrid integration with Brevo. It is a PR for
Matt to review, **not deployed**. A controlled test through the real transport was accepted and reported delivered by Brevo on September 17.

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

Apply additive migrations `006_notifications.sql`, `007_email_confirmation.sql` and `009_brevo_delivery_events.sql` through the existing migration
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
BREVO_WEBHOOK_TOKEN=<independent random secret, at least 32 characters>
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
not successes. Brevo acceptance does **not** prove inbox delivery. Delivery events are stored separately from acceptance. POST `/api/webhooks/brevo` requires the configured bearer token, validates events, deduplicates retries and retains callbacks that arrive before the send response. The `app_notification_delivery_status` view joins events to their outbox records. Unsubscribe callbacks disable all emails for the matched account; callback recipient addresses cannot change another account.

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

## Confirmation and waiver controls

New accounts remain pending until a single-use confirmation link is consumed.
Existing accounts remain confirmed. Tokens expire after 24 hours (an implementation
default), are stored hashed, and are sent in a URL fragment. The page explicitly
POSTs confirmation so a mail scanner's GET cannot consume the link. Confirmation
creates the login session. Resend and email correction require the pending account's
password, have a 60-second cooldown and invalidate older links. Email-off environments
show that delivery is disabled; demo users remain available without registration.

Staff → member details lets an authorized admin set or clear waiver expiry with a
reason and stale-edit protection. Changes are audited and refresh pending reminders.
Expired waivers no longer satisfy eligibility; re-signing preserves the old record.
Profile and authorized admin views download the signed text/version/signature from
the original snapshot, even when the user opted out of email. Legacy records without
a saved snapshot report that the copy is unavailable instead of recreating one.

## Requirement traceability / tracking updates

- SDTA-139 foundation: FR-013–017 (all user types, subject, postal address,
  sender/recipient and opt-out), NFR-002/003.
- SDTA-140 templates: FR-027/028/030–034/063–068; distinguish wired sources above.
- SDTA-141 scheduling: FR-045, BR-010 (one week), BR-009 (98% as clarified).
  FR-056 auto-renewal notification remains dependent on an auto-renewal source.
- SDTA-142 now records the confirmed all-notifications opt-out policy.

Live source documents checked before coding:
- [Requirements](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit)
- [Architecture](https://docs.google.com/document/d/1CeyE5pD_pmIZr6uXAO0zj9VhvVfYmsID3w42Trb4ly4/edit)
- [Use cases](https://docs.google.com/document/d/1ivzrEd9E1mOIvG0llNb8ptt4l26qe7HpIP3UzzUibGM/edit)

The live architecture document and SDTA-139 through SDTA-142 were updated and
read back on September 17. The tickets link this PR and do not claim deployment.

## Checked live / activation after review

Brevo reports transactional relay enabled and the Yahoo sender active. One controlled
email sent with this code to the team mailbox was accepted at 22:00:06 UTC on
September 17 and reported delivered at 22:00:11 UTC. This establishes one real
provider delivery, not a 98% service record or guaranteed inbox placement.
Brevo rewrites the Yahoo sender to `arborcollaboratory@12181182.brevosend.com`;
reply-to remains the team Yahoo address.

After review and deployment, set the backend-only API key, app origin and independent
webhook secret. In Brevo's transactional webhook configuration, use the public HTTPS
URL ending `/api/webhooks/brevo`, enable delivery/bounce/unsubscribe events and configure
Bearer authentication with the same `BREVO_WEBHOOK_TOKEN`. Do not put the secret in
the URL. The endpoint returns 503 if unconfigured and 401 for incorrect authentication.
A public callback has not been registered because this branch has not been deployed.
Review pre-enable queued notices before turning on the worker. Never enable delivery
against synthetic/demo recipients. Account handoff remains deferred.
