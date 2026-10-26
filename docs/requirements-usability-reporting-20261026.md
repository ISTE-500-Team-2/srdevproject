# Requirement and usability fixes

Scope: the implementation gaps found during the October26 requirement check. This change does not mark every MVP requirement accepted, deploy the application, change cancellation/pricing rules, or operate hardware.

## Implemented

- **NFR-006/017:** authentication refresh has a separate120requests/minute/IP throttle, rather than consuming the30requests/15minutes sign-in bucket. Sign-in throttling, origin/CSRF validation and rotating refresh/replay protection remain. Tested40valid rotations plus re-login, preserved sign-in throttling, invalidCSRF and independent refresh throttling.
- **NFR-017/018:** dialogs trap forward/backward keyboard focus, keep background content inert, restore the trigger, maintain nested-dialog scroll locking and use unique accessible titles. The member-demo Certifications grid/filter now shrinks and wraps on phone widths.
- **NFR-017:** name/email member lookup returns only identity fields, at most25matches with a refine-search indicator. It checks training-read permissions for staff/admin/instructors without granting instructor access to the admin user directory. Member selectors replace numeric typing in training, reader cards, staff reservations and partner verification. Training equipment uses named searchable checkboxes; class scheduling uses certification/instructor/room selectors. Server permissions, expiry and capacity/conflict validation remain authoritative.
- Remove the empty Accessibility card/link. Replace unavailable/preview training messaging with links to implemented classes and registration.
- **FR-077:** Reports and CSV/PDF exports now include new, active, expiring and cancelled-member counts, grouped daily/weekly/monthly in the configured reporting timezone.
- **BR-009/010 reporting:** report waiver/training expiration, membership expiration and other-notice cohorts separately. Deadline-passed eligible denominator, on-time provider acceptance, delivered callbacks, delivery failures and unresolved sends are distinct. Empty cohorts show **Not measured**, never100%. Duplicate callback events cannot multiply delivered-message counts. No new messages are sent by reading reports.

## Reporting definitions and limits

Membership counts are distinct people, not invoices. New means the first recorded membership start; a renewal is not a new member. Active coverage uses currently active membership records overlapping each bucket, **not reconstructed historical account eligibility**. Expiring periods have no currently active continuation covering their end. Current record changes can affect coverage/expiry counts for old periods; the report says so.

Cancelled means confirmed recurring-billing cancellation requests by their recorded request date. It uses the current confirmation flag or the retained cancellation-confirmation event, independent of email delivery, so a later terminal provider update cannot erase an acknowledged request. Paid access can remain active. Abandoned checkouts, expiry, suspension and administrative revocation are not user cancellation requests. Unknown/undated legacy cancellations are not invented. These definitions need reviewer agreement before using the report as a business KPI.

Notification windows use **deadline dates**, not creation dates; future deadlines do not enter percentage denominators. BR-009's waiver/training cohort is never blended with successful account emails. Repository documentation's provider-acceptance interpretation and the sheet's delivered wording remain distinct; both measures are exposed. Delivered callbacks are not evidence of inbox placement. No representative operational98% claim is made.

## Verification

Node24.22.1, isolated PostgreSQL16:

- Backend build,41unit tests and165integration tests pass. The integration run used `tsx --test --test-concurrency=1 test/integration/*.test.ts` locally; normal CI uses the repository default command.
- Frontend build,77unit tests and26HTTP/PostgreSQL integration tests pass.
- Reader11, deployment7, auto-release12, edge2 and launcher5 tests pass: **346 distinct local automated tests**.
- Additional headlessChromium acceptance:28layout observations at320/375/390/768/1440 widths across the targeted member routes, including normal-account Certifications;80forward/backwardTab steps stay inside the reservation dialog andEscape restores its trigger. Named-equipment training creation, member lookup, named class scheduling and new report sections are exercised against the real local backend/database. No runtime page errors.
- The first parallel local backend run returned two unexpected502responses. Both original tests passed17/17 in focused recheck, then the complete165test serial run passed. This is not counted as two fixed application bugs; CI results must be checked on the PR's actual head.

Reproduce with explicit isolated PGHOST/PGPORT/PGUSER/PGDATABASE and Node from `.nvmrc`:

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm run check --prefix backend
npm run check --prefix frontend
npm run test:integration --prefix backend
npm run test:integration --prefix frontend
python3 -m unittest discover -s deploy/reader -v
python3 deploy/test_deploy.py
python3 deploy/test_auto_release.py
node --test deploy/rles-edge.test.mjs scripts/dev.test.mjs
```

No new migration is required. Application code still expects the existing merged migration set. Production release/data cutover, physical relay accuracy, real-device/novice-user acceptance, RLES encryption-at-rest evidence and sustained notification delivery remain separate acceptance work.
