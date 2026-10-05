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
