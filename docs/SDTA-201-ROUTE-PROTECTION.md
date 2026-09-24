# SDTA-201 — Route/page protection

## Source and scope
Live Jira checked September 24, 2026: SDTA-201, “Implement route/page protection”, assigned to Matt Marana, due September 25; description/acceptance criteria are empty. The checklist below is an implementation/testing interpretation, NOT purported verbatim Jira acceptance criteria. Preserve backend RBAC from PR #14 and add frontend regression coverage.

## Route contract
- Public: `/login`, `/confirm-email`, `/loading`, not-found page. No protected records are rendered by these pages.
- Authenticated: `/`, `/profile`, `/membership`, `/reservations`, `/certifications`, `/classes`.
- Staff workspace: `/admin` (including its query-selected tabs). Any assigned staff/admin role qualifies; primary role alone does not determine access.
- Members, subscribers/day-pass users, instructors and the student modifier do not grant staff access by themselves.
- Admin-only actions remain backend permission checks; there is no new standalone admin-only route in this application.

## Changes
- Extract reusable user/staff guards from App.
- Revalidate `/auth/session` before mounting protected content at each router location; initial deep links cannot flash cached private pages.
- Explicit “Access denied” with a return-home link instead of an unexplained home redirect.
- On focus, visibility return and page restoration, refresh current roles/session without unmounting authorized forms. Existing sessions reflect server-side revocation/demotion on their next check; this is not server-push revocation.
- Unavailable server: hide protected route behind retry feedback, not a false successful authorization or misleading invalid-password response.
- Ignore obsolete session reads after a newer auth transition or session-expired event. Clear protected user state on successful logout/expiration.
- Preserve the existing profile-save notification: normal profile-triggered session refresh stays nonblocking.

## Security boundaries and limitations
The frontend is navigation/UX protection, not the authorization boundary. Existing backend middleware rechecks permissions; API tests assert 403 even if the user attempts a staff URL directly. No backend authorization is loosened. No role polling timer, cross-tab broadcast, immediate remote revocation push, or promise to erase screenshots/browser caches is introduced. A currently visible tab learns about external changes on navigation/tab return/API failure. Failed logout still reports failure rather than claiming server revocation succeeded.

## Verification
- 26 frontend unit/component tests, including 16 new guard/session cases (role matrix, delayed reads, expiration, focus return, denied navigation, errors/retry, logout, public confirmation, unsaved edits).
- 15 frontend/Express/PostgreSQL integration tests, including 11 new cases: seven signed-out deep links; member UI/API denial; real staff-role demotion; server logout/page restoration; profile save-popup regression.
- 52 backend database integration tests and 26 backend unit tests pass.
- Frontend and backend production builds pass; `git diff --check` clean.
- Real backend integration uses disposable local PostgreSQL databases on 127.0.0.1:55501, not RIT. React tests run in jsdom, NOT a new real-browser visual rehearsal.
- GitHub CI status is separate and must be checked before merge.

## Review and release
Stacked on `feat/rbac-completion` (PR #14) to keep Matt's review focused. Excludes PR #23 equipment changes and PR #22 Stripe work. Merge #14 first, retarget this PR to main if GitHub does not do so automatically, recheck the diff/CI, then merge. No schema migration or environment variable is added by this PR. Rebuild/redeploy frontend through the normal reviewed release path; do not enable demo-login shortcuts in production. Verify signed-out `/admin`, member denial, staff access, logout, and profile-save popup on the deployed version. Roll back to prior frontend artifact if needed; no data rollback is necessary for these changes. Nothing deployed by this task.
