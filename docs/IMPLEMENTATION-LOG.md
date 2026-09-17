# Primary MVP implementation log

This is a development record for the team, not a claim of sponsor approval or a submitted Gate Review.

## 2026-09-08 — scope and baseline

- Authorized by Max: add membership/day-pass management, staff access administration, payment-history records, and detailed documentation.
- Baseline: local `feat/mvc-integration`, commit `98484cc`. Existing MVC integration and its 18 tests are preserved as the regression baseline.
- Environment: isolated `arbor-mvc` demo only. The migrated team dev/staging/production databases and original repository checkout are not targets.
- Source: sponsor **Makerspace Membership and Equipment Access Management System** brief and Fall 2026 ISTE 501 Gate Review 1 assignment, verified on September 8.

## Implementation decisions — pending sponsor confirmation where noted

1. Reuse `membership_tiers`, `user_membership`, `day_pass`, `payment`, `user`, and `waiver`; add migration 002 rather than changing applied migration 001.
2. Membership plans have calendar-month durations; day passes cover one calendar day in `APP_TIME_ZONE`. Prices use exact decimal USD strings. These defaults need sponsor confirmation.
3. Preserve issued plan snapshots when catalog prices/benefits change. Archive plans instead of deleting purchase/history records.
4. Account authentication and facility access are separate. A suspended/revoked facility member can still sign in to see their account; server-side booking/check-in must refuse access.
5. Staff can manage members. Only administrators can manage staff roles or publish policy versions. No self-demotion or self-access changes through the staff console.
6. Issuing an entitlement records the corresponding payment history atomically. Staff may record a payment received externally; this application does not charge cards or execute refunds. Access grants are explicit staff decisions, not inferred from a payment flag.
7. Mutating staff actions require a reason and record actor, timestamp, target, and before/after state. Audits are append-only through the application, not tamper-proof against database administrators.
8. Use row locking, optimistic revisions, and issuance request IDs to prevent lost updates and accidental repeat issuance. Test these, do not assume they work.
9. Preserve signed waiver versions. Provide a way to publish full policy text with its source/approval reference, but do not invent a sponsor legal waiver. The seeded policy remains a clearly identified fixture until approved text is supplied.

## Planned verification

- Existing regression suite; new real-PostgreSQL staff authorization, plan CRUD/archive, membership/pass issuance, renewals/expiry, suspension/revocation, payment transitions and audit tests.
- React → Express → PostgreSQL staff workflow, including reload persistence and member-side access enforcement.
- Migration rerun preservation and isolated container restart persistence.
- Record actual results, exact commands, remaining limitations and handoff steps before delivery.

## Open sponsor decisions (not silently treated as approved)

- Approved waiver text and version/approval owner.
- Final tiers, prices, benefits, duration/renewal/refund rules; whether unpaid records should block staff-issued access.
- Staff vs administrator permissions and whether a self-reported authenticated web check-in is sufficient.
- Suspension handling for existing reservations; this implementation preserves bookings/history and blocks new access, rather than automatically cancelling/refunding anything.

## Backend and UI implementation checkpoint

- Added migration `002_primary_mvp.sql`: plan kind/benefits/archive/revision, independent facility-access status, issued-plan snapshots, issuance/payment metadata, full-length policy text, audit and idempotency tables. Applied only in fresh disposable test databases so far.
- Added `StaffModel`, `StaffService`, `StaffController`, validation helpers, and staff-protected routes; member-owned membership/payment read endpoints.
- Added Staff workspace sections (Members, Plans, Payment history, Policies, Change log), member Membership page, and retained the prior analytics mockup behind an explicitly named preview tab.
- Added checks for actor permissions inside staff transactions, stale revision rejection, duplicate issuance replay, overlap/duplicate-pass prevention, payment state transitions, and record ownership.
- Fixed two relevant inherited behaviors: demo reseeding must not recreate revoked/expired access; exact membership-end time now expires check-in eligibility while permitting an adjacent reservation boundary.
- Fixed asynchronous view loading so an aborted request cannot overwrite another member's freshly selected details.
- Backend and frontend compile. All seven original PostgreSQL integration cases passed with both migrations. New primary tests and the real-HTTP React staff workflow are in progress; passing results are not assumed.
- Test setup initially failed before any SQL because the old local SSH database forward had ended. Established a fresh key-authenticated loopback tunnel and reran the suite; this was a connection/preflight issue, not a lost database or schema change.

## Verification checkpoint — primary flows

- Existing seven real-database regression tests remain green. Both React/Express/PostgreSQL integration flows passed, including the new staff plan/issuance/reload/member-history/suspension flow.
- New server tests passed staff/member authorization, live role revocation, optimistic revisions, plan validation/archive, atomic retry-safe issuance, snapshot preservation, adjacent renewal, facility suspension/revocation, and day-pass status handling.
- Payment transition testing exposed PostgreSQL parameter type inference (`42P08`) when one parameter was used for a varchar assignment and text comparison. Added explicit text casts; rerunning the payment cases and complete candidate checks before deployment.
- Tests execute against unique disposable databases. The candidate container will be verified before replacing the separate demo app; the original migrated team stack remains out of scope.

## Candidate verification passed

- Verified the candidate in a Docker `verify` target on the VM, using only the isolated PostgreSQL server and disposable databases. This avoids round-trip latency through the SSH test connection.
- **28 automated tests passed:** 4 backend unit, 6 frontend unit, 16 backend/PostgreSQL integration, 2 React/Express/PostgreSQL integration.
- The payment cast fix passed its positive, stale-update, invalid-transition, refund, ownership and audit tests. Added and passed waived/void and invalid legacy-price cases.
- Both TypeScript builds and the Vite production build passed. New code was formatted for team readability without changing application behavior.
- Still to verify: upgrade preservation and app-container restart on the separate persistent demo, final source/documentation packaging. Browser visual QA and sponsor rule approval are not claimed.

## Runtime upgrade and backup checks

- Backed up the persistent isolated demo before upgrade: `/home/student/arbor-mvc-pre-primary-vFdV8Dzq/` contains a custom-format PostgreSQL dump, source archive, pre-upgrade record counts and SHA-256 manifest. Directory/files are private to the VM operator.
- Upgraded only `arbor-mvc-app-1`. Before/after baseline counts matched: 2 users, 2 memberships, 1 reservation, 0 payments, 0 signatures.
- Restored that dump into a newly created disposable restore-test database; all five counts matched. Both archive checksums passed. Removed only the disposable restore-test database afterward.
- Created a labeled synthetic runtime fixture, issued membership/payment, recorded agreement/check-in, restarted the app container, and verified both sessions and saved records survived. Replaying the original issuance request returned the same result; later suspension blocked another check-in. The successful fixture was suspended and its plan archived, with audit/history retained.
- An initial smoke harness request used Python's six-digit microsecond timestamp, outside the millisecond API input contract. Corrected the harness to emit milliseconds; retained and disabled/archived only its incomplete synthetic fixture. No real account or payment was involved.
- Original six dev/staging/production PostgreSQL/MinIO containers remained healthy; the isolated app and database were also healthy.

## Final startup-preservation correction

- Review found demo bootstrapping could restore a deliberately removed demo admin role, even though ordinary member-role checks were correct.
- Changed bootstrap to assign roles/membership only when it creates the demo identity; renamed/archived demo day-pass offers are not recreated on repeat startup.
- Added a real-API regression: create a successor administrator, demote the demo administrator, rename/archive the sample pass plan, rerun initialization, and verify both decisions persist. Running the complete final candidate suite before release.

## Final candidate and handoff checkpoint

- The complete final Docker verification command exited successfully: **29 tests** (4 backend unit, 6 frontend unit, 17 PostgreSQL integration, 2 React/HTTP/PostgreSQL integration), followed by a successful runtime image build and isolated app-container recreation/start. The added startup-preservation regression passed.
- Detailed handoff, API/rule notes, migration/rollback precautions, feature evidence matrix, verification record and editable Gate 1 summary outline are in `docs/`. The outline is not a completed/submitted slide deck.
- A subsequent readback through the existing temporary SSH relay timed out. Documented that access limitation instead of claiming a final live health check; the immediately prior candidate passed actual restart and backup restoration tests.
- Distribution: local `feat/mvc-integration` commit plus `Collaboratory-MVC-Primary-2026-09-08.zip`; `BUILD-INFO.txt` in the archive identifies the exact commit. Documentation links and whitespace checks passed. No GitHub push, email, course submission or original-team-database migration is part of this delivery.
