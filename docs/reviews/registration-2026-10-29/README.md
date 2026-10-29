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

## Initial registration validation

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

## Email validation follow-up

Replaces the custom email regex with pinned `validator` 13.15.35 and
`@types/validator` 13.15.10. One commented `emailField` helper now handles signup,
login, confirmation resend/address correction, password recovery and waiver email
fields. The existing whole-address lowercase comparison policy and 100-character
storage limit are retained; no stored addresses or database schema are changed.

- Leading/trailing whitespace is trimmed only after rejecting control characters
  and invisible formatting characters. CR/LF, tabs, NUL and zero-width input fail
  validation rather than being silently stripped. Login passes the original
  email to this helper so its earlier identifier parsing cannot hide controls.
- Meaningful mailbox punctuation is retained: ` First.Last+Studio@Example.COM `
  becomes `first.last+studio@example.com`. Dots and plus tags remain intact;
  provider-specific rewriting and domain-specific mailbox restrictions are off.
- The library validates a single mailbox, including mailbox/domain length and
  dot placement. Display names, lists, IP literals and malformed domains are
  rejected. SMTPUTF8 local parts are unsupported; ASCII punycode domains are
  covered by the unit tests. No DNS lookup or provider-specific alias merging is
  performed, and format validation never creates a verified member.
- Single-use inbox confirmation, duplicate-request protection, rate limits and
  expiry remain the ownership and abuse controls. Dependencies are locked in
  `backend/package-lock.json`; installation reported zero known vulnerabilities.

The implementation follows the separation between normalization, format checks
and ownership verification in [OWASP's email guidance](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html),
using [validator's documented options](https://github.com/validatorjs/validator.js#validators).

### Follow-up verification

New regression coverage exercises retained dots/plus tags/apostrophes, case and whitespace,
punycode, unsafe characters, storage limits and malformed mailbox/domain input.
The isolated PostgreSQL/API scenario follows signup → duplicate submission →
authenticated address correction → fake delivery → confirmation → login →
password-reset lookup. A second scenario checks every email account endpoint
rejects malformed input without changing users, pending requests, mail or reset
records.

- Backend TypeScript build and all 59 unit tests passed.
- All 244 backend integration tests passed with four workers, including the two
  new end-to-end email scenarios and the existing registration, confirmation,
  password reset, waiver, audit and account-security regression coverage.
- All 35 frontend integration tests passed across 14 files with two workers.
  Frontend source and dependencies did not change in this follow-up; its unit
  tests were not repeated. The earlier 254-test result is recorded separately
  above.
- The existing Compose app was rebuilt successfully and both containers are
  healthy. Five direct localhost requests exercised malformed dot placement,
  CR/LF header injection, a leading newline on login, zero-width address
  correction and display-name reset input; all returned `400 INVALID_INPUT`.
  User, pending-request and mail counts were unchanged at 4, 2 and 13 respectively.
- `git diff --check` passed. Test databases were isolated; existing demo volumes
  were retained. No real email was sent and no production migration, merge or
  deployment was performed.

Reproduction commands, run from the repository root with the existing Compose
database available (each integration suite creates and drops its own test databases):

```sh
docker build --target verify -t arbor-registration-verify .
docker run --rm --entrypoint npm arbor-registration-verify run check --prefix backend
docker run --rm --network arbor-mvc_mvc \
  -e PGHOST=db -e PGUSER=arbor_mvc -e PGDATABASE=postgres \
  -v "$PWD/deploy:/app/deploy:ro" --entrypoint sh arbor-registration-verify \
  -c 'cd backend && node --import tsx --test --test-concurrency=4 test/integration/*.test.ts'
docker run --rm --network arbor-mvc_mvc \
  -e PGHOST=db -e PGUSER=arbor_mvc -e PGDATABASE=postgres \
  --entrypoint npm arbor-registration-verify \
  run test:integration --prefix frontend -- --maxWorkers=2
```
