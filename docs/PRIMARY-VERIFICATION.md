# Primary MVP verification — 2026-09-08

## Automated checks — passed

Executed on the VM's Docker `verify` target against the separate PostgreSQL demo server. Each integration suite creates fresh uniquely named `_mvc_test` databases; it does not reset the persistent demo or original team databases.

| Suite | Passed | Source |
| --- | ---: | --- |
| Backend unit | 4 | `backend/test/domain.test.ts` |
| Frontend unit | 6 | `frontend/src/data/mockData.test.ts`, `frontend/src/lib/reservationInput.test.ts` |
| Backend/PostgreSQL integration | 17 | `backend/test/integration/mvc.test.ts`, `primary.test.ts` |
| React/Express/PostgreSQL integration | 2 | `frontend/test/integration/mvc-flow.test.tsx`, `staff-flow.test.tsx` |
| **Total** | **29** | No skipped cases in the final successful candidate run |

Also passed: backend TypeScript build, frontend TypeScript/Vite production build, Docker candidate build, and `git diff --check` at implementation checkpoints. A GitHub Actions workflow exists but has not run remotely because this work has not been pushed.

## Important covered behaviors

- Authentication/session persistence; member/staff/admin permissions and immediate loss of privileges after a role change.
- Exact decimal plan validation; archive behavior and unchanged issued plan snapshots after repricing.
- Atomic membership/pass plus payment creation; identical issuance retry returns the existing result; different input with the same request ID is rejected.
- Optimistic revisions reject stale edits instead of silently overwriting them.
- Adjacent renewal; January-31 calendar-month/leap-year behavior; computed scheduled/expired state; local-date day passes.
- Facility and individual-entitlement suspension/revocation; access checks enforced on the server without deleting account/payment/booking history.
- Membership, certification, equipment status and current-policy requirements for bookings/check-in; concurrent booking protection.
- Owner-scoped payment history; controlled paid/refunded/void/waived transitions and transactional audit records. No real charge/refund was attempted.
- Full policy text over the previous 255-character limit; new versions require new agreement; old signatures are retained.
- Migration rerun and demo restart initialization preserve expired/revoked memberships, removed demo administrator permissions and renamed/archived sample offers.
- Real React staff plan creation, issuance, full remount, member history and suspended check-in behavior through actual HTTP and PostgreSQL, alongside the original reservation/waiver/check-in React flow.

## Failure found and corrected

The first primary suite exposed a PostgreSQL `42P08` parameter-inference error on payment status updates. One parameter was being used both for a varchar assignment and a text comparison. Explicit casts resolved it; the full candidate run then passed all 28 cases, including payment transitions and waived/void cases.

The initial Mac-side test attempt also found the previous SSH database forward had ended. Reestablishing the key-based loopback forward resolved connection refusal. Running candidate tests inside the VM network reduced network round-trip latency; no database data recovery was needed.

## Persistent demo upgrade / restart

- Upgraded only the isolated demo app, not the original six development/staging/production PostgreSQL/MinIO services.
- Took a pre-upgrade custom-format PostgreSQL dump and source archive at `/home/student/arbor-mvc-pre-primary-vFdV8Dzq/`. Both SHA-256 checks passed. Restored the dump into a newly created disposable database and verified the baseline counts: **2 users, 2 memberships, 1 reservation, 0 payments, 0 signatures**. The disposable restore database alone was removed afterward.
- The initial persistent-demo migration retained those same five counts without reseeding or resetting records.
- Created a labeled synthetic member and plan, issued a membership/payment, signed a policy and checked in. After restarting the app container, both sessions and the saved records remained. Repeating the issuance request returned the same committed result; suspending access then blocked another check-in.
- Archived/suspended the synthetic smoke-test fixtures afterward, retaining their records/audit history. An earlier incomplete fixture was likewise disabled, not deleted. No actual payment or real account was involved.
- At that runtime checkpoint the original six containers and both isolated-demo containers were healthy.
- A final startup-preservation regression exposed and fixed automatic restoration of a removed demo admin role and recreation of renamed sample offers. The complete final verification pipeline then passed **29 cases**, built the runtime image and successfully recreated/started `arbor-mvc-app-1` (September 8, approximately 17:47 EDT).
- The subsequent readback through the existing temporary SSH relay timed out. **A post-final-build health read is not claimed.** The successful runtime persistence/restore tests above were performed on the immediately preceding 28-test candidate; the final change only restricts demo bootstrap, with its own additional PostgreSQL regression. The full source can be run locally using the handoff instructions.

The first runtime smoke harness sent Python's six-digit microsecond timestamp to a millisecond-precision API. The harness was corrected to emit milliseconds; this was not an application data-loss failure.

## Not established by these checks

- Sponsor approval of legal wording, prices, benefits or operating policies.
- Browser visual/device/accessibility audit, physical-presence validation or hardware-reader behavior.
- Production data compatibility beyond the documented migration preconditions, production security/operations readiness or load capacity.
- Actual payment-provider interaction, recurring billing, notifications, class registration, analytics or Figma MCP connectivity.
- Completion/submission of a Gate Review or sponsor report. See the working matrix and summary outline for review preparation.
