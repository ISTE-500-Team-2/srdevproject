# Verified-email registration — October 29, 2026

## Changes

- Public sign-up no longer asks for or stores a username. Existing usernames still
  work for existing accounts; email is the identifier for new accounts.
- Email input is checked for mailbox and DNS-style domain syntax on the server.
  Format checks cannot prove that an inbox exists: ownership is established by
  consuming the single-use confirmation token delivered to that inbox.
- New sign-ups are stored in `app_pending_registration` for up to 24 hours, with a
  password hash and confirmation-token hash. They create no user, role, session,
  membership or notification-preference records before verification.
- Confirmation creates the user and member role, saves preferences, removes the
  staged request and creates the session in one transaction. Concurrent or reused
  links cannot allocate multiple accounts.
- Repeat submissions for a pending address neither change its password nor send
  another email. Password-authenticated resend/email correction rotates the link,
  with a one-minute cooldown. Public sign-up has a separate ten-attempt IP limit
  per 15 minutes. Expired staged requests and their queued mail are pruned every
  minute, including when outbound email is disabled.
- Migration `030_pending_registration.sql` is additive. It preserves existing
  unconfirmed users and their confirmation links, changes their active status to
  pending, and excludes unverified accounts from the staff member directory.
  Existing confirmed users, roles, bookings and memberships remain intact.
- The existing leased notification worker now supports account-free confirmation
  jobs. Pending requests cannot create notification preferences through callbacks.
- Changed functionality has brief source comments explaining its purpose.
- Native date-picker input is retained between signup steps, including when the
  control emits input before change.

## Validation

- Backend unit tests: 58 passed. Backend integration tests: 242 passed, including
  malformed email, account-free staging, confirmation races, repeated requests,
  resend/corrected email, expiry/cleanup, worker dispatch, legacy-account
  migration, existing username login, audit coverage and signup rate limits.
- Frontend unit tests: 254 passed across 41 files with two workers. Frontend
  integration tests: 35 passed across 14 files. An initial run with unrestricted
  concurrency hit an unrelated reset-password focus timing failure; the bounded
  run passed. Backend and frontend production builds passed in Docker.
- Browser: completed the three-step signup without a username, retaining DOB.
  The confirmation page explicitly reports that no member account exists yet.
  The local database stayed at four users and two active users, with one temporary
  request added for the synthetic `example.invalid` address. Screenshots:
  [password step](signup-no-username.png) and
  [pending confirmation](signup-pending-confirmation.png).
- Rebuilt the existing Docker Compose app without resetting its database volumes.
  App and database are healthy; the demo is served at http://localhost:8081.

The full backend suite uses the repository's `deploy/` fixtures mounted read-only
into the verification image; its Docker target does not copy that directory.

Local demo email delivery is disabled by its existing configuration. Test sign-ups
there remain pending until confirmed; database-backed tests use an isolated test
inbox and fake delivery, never a production mailbox.
