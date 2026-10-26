# Username and member roster acceptance

Requirements: FR-018, FR-021 and FR-079. Branch starts at main `69dd7a09700087c60f4ef48cb5aac7598c2b3e35`.

## Account creation and login

New registrations require a case-insensitive, unique username of 3–30 ASCII letters, numbers, periods, underscores or hyphens, beginning with a letter or number. The UI explains this and retains the form when a username is unavailable. Names cannot contain `@`, so usernames cannot collide with email login identifiers. Email confirmation and the existing password, throttling and session controls still apply.

Migration `023_usernames.sql` adds a nullable column and a unique index. Existing accounts retain their email addresses, password hashes, memberships and sessions; no usernames are invented or backfilled. They continue signing in by email. New accounts may sign in with either username or email. `POST /api/auth/login` continues accepting the existing `email` field and also accepts `identifier`. New registration clients must provide `username`. Own-account/profile responses include the username; the profile shows it read-only.

Apply the normal additive migrations before starting the updated backend. No existing migration was edited. This migration was applied only to isolated local development/test databases during verification.

## Member class participants

Signed-in members can choose **View participants** for upcoming scheduled classes. `GET /api/classes/:id/member-roster` returns capacity, enrolled count, available seats and participant first names plus last initials. The SQL never selects emails, phone numbers, addresses, usernames, account IDs or attendance details for this response. Withdrawn/no-show entries are excluded. Missing, past or cancelled classes do not expose a participant list. Responses are marked `no-store`.

The existing instructor/staff roster endpoint and its permissions are unchanged. Members cannot call it, and unassigned instructors still cannot use it to obtain contact information. Classes/rosters refresh after registration/withdrawal, on returning to the page, every 30 seconds while visible, and through an explicit refresh button. Seat counts reflect the database at fetch time; this does not claim instantaneous push updates.

## Verification on Node 24.22.1 / isolated PostgreSQL 16.14

- Backend production build and **45 unit tests** pass.
- Complete backend integration suite: **170 tests** pass with concurrency 1. The five new focused regressions also pass after strengthening the assigned-instructor case to use an account without staff/admin roles.
- Frontend production build and **77 unit tests** pass.
- Complete frontend HTTP/PostgreSQL integration suite: **29 tests** pass. The two participant-flow tests also pass after the final singular/plural wording adjustment.
- **321 distinct automated application tests**; focused reruns are not counted again.
- Browser: an existing pre-migration member signs in by email and opens the new participant list showing `Morgan A.` and seat availability. The signup username input accepts a valid username in the browser's actual HTML validation. Before/after screenshots accompany the requirement-sheet evidence.

Regression coverage includes username normalization, required/invalid fields, concurrent case-only duplicates, email confirmation, wrong passwords, username and email UI login, duplicate-name correction without retyping, migration replay and preservation of a legacy account/session/membership, response-field privacy, anonymous denial, instructor authorization, cancelled/past classes, and seat changes after withdrawal.

The full suite also rechecks payment/access, expired/revoked waivers and training, retraining after revocation, reservations, check-in, signed copies and audit history.

## Policy questions left open

- Training certification/approval permissions are unchanged. BR-011's administrator-only training wording still conflicts with BR-012's instructor-certification requirement and needs a decision.
- Staff-issued access remains an explicit staff grant independent of a pending payment flag. Online checkout still requires verified provider payment. No payment/access policy was changed.
- Local testing does not verify production, physical reader/relay accuracy, representative notification delivery rates, or encryption at rest. Real email and payments were not enabled. No shared data was migrated, and no merge or deployment was performed.
