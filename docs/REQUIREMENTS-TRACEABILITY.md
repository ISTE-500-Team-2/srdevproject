# Requirements and technical-evidence matrix

**Team working draft — not submitted.** IDs below are local tracking IDs, not claimed to be the team's approved requirement numbers. Reconcile this inventory with the latest sponsor/use-case list and assign human testers/owners before using it for Gate Review.

Source baseline: the sponsor's **Makerspace Membership and Equipment Access Management System** brief and the Fall 2026 [Gate Review 1 assignment](https://mycourses.rit.edu/d2l/lms/dropbox/user/folder_submit_files.d2l?db=2259273&grpid=1247089&ou=1231569), read on September 8, 2026. Gate 1 requires the complete feature inventory, test/no-test explanations, and summary slides. Technical feasibility evidence is not the same as completion of every production feature.

## Status definitions

- **Confirmed:** demonstrated in the implementation/tests identified below; only the stated scope is claimed.
- **Documented:** supporting design/documentation exists, but the feature is not proven end to end.
- **Unconfirmed:** not proven, not built, or awaiting the necessary source decision.
- **Routine:** reserved for work the team can substantiate it has done repeatedly. No row is labeled Routine merely because it sounds familiar.

Evidence labels:

- **B0:** `backend/test/integration/mvc.test.ts` — seven original API/PostgreSQL cases.
- **B1:** `backend/test/integration/primary.test.ts` — ten primary-workflow API/PostgreSQL cases.
- **U0:** `frontend/test/integration/mvc-flow.test.tsx` — actual React components through Express HTTP into PostgreSQL.
- **U1:** `frontend/test/integration/staff-flow.test.tsx` — staff plan/issuance/reload/member-history/suspension flow through the same real stack.
- **D:** `TEAM-HANDOFF.md`, `MVC.md`, migrations, and source code. Documentation alone is not a passed test.
- **V:** `PRIMARY-VERIFICATION.md` — test counts, runtime checks, boundaries and limitations.

Tests were executed by the automated suites under Z's implementation session. Human review/test ownership is **unassigned**, not invented.

## Primary sponsor MVP

| ID | Requirement / tested scope | Status | Evidence / explanation | Remaining decision or limitation |
| --- | --- | --- | --- | --- |
| P01 | Customer registration, authentication and persistent session | Confirmed | B0 registration/session/logout; U0 full remount | Password recovery/SSO are not part of this proof |
| P02 | Staff accounts and role-controlled management | Confirmed | B1 authorization/role-change case; U1 staff workspace | Registered accounts are promoted by an admin; no invitation email; confirm final role policy |
| P03 | Define membership prices, durations and benefits; multiple tiers | Confirmed | B1 plan validation/archive/snapshot cases; U1 plan creation | USD/month-based defaults; benefits are descriptive, not a sponsor-specific rules engine |
| P04 | Issue and manually renew dated memberships | Confirmed | B1 atomic issuance, adjacent renewal, month-end/leap-year boundary | Automatic billing/renewal not implemented; clarify meaning of recurring membership with sponsor |
| P05 | Define and issue one-time day passes | Confirmed | B1 pass date, duplication, suspension and revocation | One date in configured makerspace timezone; no hardware scan |
| P06 | Grant, suspend, revoke and restore facility access | Confirmed | B1 access-state enforcement; U1 suspension and denied member check-in | Existing reservations/history are preserved; final cancellation policy pending |
| P07 | Digital policy/waiver acknowledgment with retained signature history | Confirmed | B0 consent/check-in; B1 full text/new version; U0 agreement | Software tested with fixtures, not a legal acceptance claim |
| P08 | Require active dated entitlement and required waivers before check-in | Confirmed | B0 eligibility; B1 suspension, passes, policy changes and expiry | Payment-to-access policy is explicit staff issuance, pending sponsor confirmation |
| P09 | Web check-in tied to a unique authenticated member ID | Confirmed | B0/B1 check-in records; U0 check-in; U1 blocked check-in | Self-reported web action; does not establish physical presence |
| P10 | Log timestamp, user ID and location for each accepted check-in | Confirmed | B0 creation and B1 post-suspension checks; staff recent log view | Free-text location, not verified device/location identity |
| P11 | Staff dashboard to manage members/access | Confirmed | B1 profile/status/role permissions; U1 operational views | Email/password-account lifecycle changes are not implemented |
| P12 | Staff payment-history management | Confirmed | B1 ownership, state transitions, audit, waived/void cases; U1 persistence | Records external payments/refunds only; no processor or partial-refund workflow |
| P13 | Retain operational history while plans and access change | Confirmed | B1 plan snapshots, revision rejection, idempotency, audit and reseed preservation | Audit is application-append-only, not tamper-proof against DB administrators |
| P14 | Sponsor-approved actual policy text, pricing and operating rules | Unconfirmed | D identifies exact open decisions and available configuration screens | Sponsor-authorized wording/prices have not been supplied/verified |
| P15 | Future scale/location extensibility | Documented | Existing location fields, relational tier IDs, controller/service/model separation | No multi-site authorization model, load test or capacity claim |

Hardware-based check-in is an alternative path in the brief. This slice demonstrates the web option; reader/fob/badge/QR hardware is not marked Confirmed.

## Secondary sponsor features

| ID | Feature | Status | Explanation / next evidence needed |
| --- | --- | --- | --- |
| S01 | Equipment reservation scheduling | Confirmed | B0/U0 persistence, ownership and concurrent overlap; B1 held access blocks new booking |
| S02 | Room/studio reservations | Unconfirmed | Equipment flow is not proof of room/studio rules or leasing |
| S03 | Integrated payment processing | Unconfirmed | No provider connection or actual charge/refund test; record keeping is separate |
| S04 | Automated expiry/reservation reminders | Unconfirmed | No email/reminder integration; expiry checks themselves work without notifications |
| S05 | Event guest check-in and attendance | Unconfirmed | Guest/event workflow not connected |
| S06 | Usage analytics and utilization dashboards | Unconfirmed | Existing charts explicitly remain sample previews |
| S07 | Mobile/tablet-friendly interface | Unconfirmed | Responsive CSS exists; device/browser visual validation is still required |
| S08 | Group/team/corporate memberships | Unconfirmed | Individual memberships only |
| S09 | Guest access and temporary visitor tracking | Unconfirmed | Guest table is not a tested application flow |
| S10 | Multi-location support | Unconfirmed | Location labels alone are not operational multi-site support |
| S11 | Institutional/student-ID integration | Unconfirmed | No identity-provider or card-system integration |
| S12 | Multi-language interface | Unconfirmed | English UI only |

## Additional team UI / technical scope

| ID | Feature | Status | Explanation |
| --- | --- | --- | --- |
| T01 | Classes and class registration | Unconfirmed | Exported-mockup screen remains a clearly labeled preview; reconcile with approved team feature list |
| T02 | Frontend-to-database read and write | Confirmed | U0 and U1 cross actual React, HTTP controllers and PostgreSQL; not a mocked API |
| T03 | Third-party package feasibility | Confirmed | Pinned React/Express/pg builds and tests pass; Docker image builds; see V |
| T04 | Business-rule process feasibility | Confirmed | Tested booking concurrency, dated access, role enforcement, consent/version handling and payment transitions; sponsor policy correctness is separate P14 |
| T05 | Isolated demo and persistence | Confirmed | V records migrations, preservation and app-restart evidence; no production readiness claim |
| T06 | Public access/deployment readiness | Unconfirmed | This change serves the private loopback demo, not a new public release; external hostname/networking is not revalidated here |
| T07 | Figma MCP connection | Unconfirmed | Not configured by this work; code is based on prior exported mockups |

## Review preparation still needed

- Match these temporary IDs to the final team requirements and add any omitted team-approved features.
- Assign presenters and human testers; add manual/browser/device results as they are actually performed.
- Resolve P14 with sponsor evidence; do not relabel it Confirmed just because configuration forms exist.
- Use [GATE1-SUMMARY.md](GATE1-SUMMARY.md) as an editable slide outline, not a claim that final presentation slides were submitted or approved.
- The sponsor Quad Chart/presentation is a different deliverable and is not replaced by this matrix.
