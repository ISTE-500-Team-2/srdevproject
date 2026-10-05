# Frontend maintainability cleanup

## Baseline

- Base: `origin/main` at `9f69c811` (Node 24.21.0).
- Separate worktree and branch; existing checkouts and `stylingBranch` untouched.
- Frontend: 36 unit tests, TypeScript/build passing.
- Backend: 32 unit tests, TypeScript/build passing.
- PostgreSQL 16 on a separate loopback port with disposable test databases:
  backend integration 108 tests passing; frontend integration 19 tests passing.
- 84 deterministic Chromium screenshots: 1440x1000, 768x1024, 390x844;
  fixed browser clock/timezone and replayed API responses from isolated demo data.
  Includes member pages, admin/staff tabs, member detail, studio configuration,
  reservation/search dialogs, equipment error and empty states. No runtime errors.
- Screenshots are local review artifacts, not production data. Snapshot staff-role
  responses are visual fixtures; actual authorization is checked by integration tests.

## Scope and retained requirements

Preserve design, requests, role restrictions, revisions, retry identifiers and
component reset keys. Retain class catalog/analytics previews and future class,
instructor, training and analytics requirements. Preserve backend demo accounts.
The equipment type is used by the live contract, so it is not exclusively sample
code and must remain. Available plans are independently requested and displayed.

## Verification commands

Use Node 24.15+ in the 24 LTS line. Supply explicit isolated PostgreSQL variables
for integration tests; never point these suites at a deployed project database.

```
npm run check --prefix frontend
npm run check --prefix backend
npm run test:integration --prefix frontend
npm run test:integration --prefix backend
git diff --check
```

## Explicitly deferred behavior changes

Draft preservation during refresh, stale studio revisions, coordinated billing
refresh and modal focus lifecycle remain separate fixes. Do not silently fix them
as part of extraction. No new dependency/framework/build pipeline is introduced.
Rollback is a revert of the PR.

## Final review and results

- Removed `SectionHeading` and unused frontend users/equipment/studios/credential
  fixtures. Retained class fixture tests, analytics series and live equipment type.
- Extracted studio calendar/configuration/payment controls and staff member-detail,
  access-issuance and payment controls; caller reset keys and hook ownership remain.
- Moved studio/billing/waiver response types and date/currency helpers out of pages.
- Chart markers use direct numeric coordinates; tab metadata selects its content
  consistently, retaining the existing unknown-tab fallback and role boundaries.
- Dense billing, confirmation, profile and waiver code is formatted with a locally
  available formatter; no formatter dependency or pipeline changes were added.
- Removed 68 wholly unused CSS rules (404 lines), including responsive overrides.
  Checked against current TS/TSX and unmerged website branches (`stylingBranch`,
  `demo`, `loginpage`). Retained complete shared rules and dynamic modal variants.
  Parsed CSS confirms all retained selectors, declarations, media contexts and
  cascade order are unchanged.
- Frontend check: **45 tests pass**, TypeScript/build pass. Eleven focused new
  tests protect chart geometry, access retry identifiers, payment revisions,
  studio configuration and payment/refund routes, and calendar boundaries.
- Backend check: **32 tests pass**, build passes. Backend integration: **108 pass**.
  Frontend integration: **19 pass**. Development-launcher tests: **5 pass**.
- **87 visual comparisons** with fixed browser time/timezone and identical API
  fixtures. Desktop/tablet/mobile, member/admin/staff pages, member details,
  configuration, reservation/waiver/search dialogs, equipment empty/error states.
  **86 are pixel-identical**; the remaining desktop studio capture differs by
  86 pixels on native control/scrollbar edges, with no content/layout difference.
  Transient native scrollbars were suppressed for calendar comparisons. Required
  fonts are explicitly loaded and data-loading states awaited. No runtime errors.
- Keyboard review compares the unchanged baseline and refactor: equipment dialog
  Enter/Tab/Escape, mobile navigation, class filtering and search result activation.
- Full diff reviewed against `main`; `git diff --check` passes. No backend,
  database, package-lock or production configuration changes.

### Limitations

Chromium with isolated/replayed demo data is not a production browser matrix.
Staff screenshots use role fixtures; actual role enforcement is covered by the
existing real-backend integration suites. Public email confirmation is covered
by existing component/integration tests, not a live email-delivery test. No real
Stripe transaction, deployed RLES verification or physical-reader test was run.
Known draft/refresh, stale-revision and modal-focus issues are deliberately not
fixed or claimed fixed here. Backend test-only typing cleanup and CI-on-main
changes from the earlier audit remain separate work.
