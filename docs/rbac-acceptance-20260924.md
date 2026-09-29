# SDTA-119 acceptance evidence — 2026-09-24

## Integration and source

Live Jira SDTA-119 was read on September 24 (due September 25). This branch integrates `release/promote-demo-fixes` at 7deeac9, preserving the current confirmation, styled-email, save-feedback and deployment-documentation changes. No production database or runtime was changed by this verification.

## Acceptance mapping

| Ticket requirement | Implementation and verification |
| --- | --- |
| Community Member, Student, Subscriber, Day Pass, Instructor, Staff, Super Admin | Existing `member` and `admin` identifiers retain compatibility; subscriber/day_pass/instructor/staff assignments supported. Student is `isStudent`, following the ticket's explicit note rather than creating a permission-granting student role. `primary.test.ts` checks role validation and customer/staff access; browser admin editor saves the flag and role set. |
| One primary role and multiple roles per account | Primary must belong to the assigned set. Tests reject inconsistent/duplicate role payloads, verify legacy updates preserve secondary roles, and cover primary changes. |
| API middleware checks before handlers | Protected business routes use permission middleware; database roles are reloaded on requests. Tests demonstrate active-session access granted and revoked without re-login, explicit deny handling, and ownership restrictions. |
| Existing accounts remain usable | Migration test reconstructs the legacy schema, migrates twice and checks IDs, credentials, status, roles and deny grants. Added assertions prove session and refresh-family records are unchanged, the pre-migration JWT resolves, and the remembered refresh token still rotates. |
| Instructor reservation restriction | Reservation creation rejects instructor presence, including multi-role accounts. Existing membership, waiver, certification, suspension and ownership rules are retained; role labels do not manufacture entitlement. |

Linked requirements reviewed against the September 24 requirements-sheet snapshot: FR-004/005/006/008/009/010/012 role identities; BR-004 primary role; NFR-001 multiple roles; FR-013 notifications remain available through existing notification/preferences infrastructure; FR-020 authorization preserves qualification checks. This does not certify physical machine-reader integration or every project notification event as complete.

## Evidence

- Full local suites: 52 backend integration + 26 backend unit + 4 frontend integration + 10 frontend unit = **92 tests**, both builds pass.
- After adding migration session assertions, the migration test was rerun and passed.
- Actual browser against the integrated server and isolated PostgreSQL: admin adds staff role and student flag to existing seeded member, saves, reloads and verifies persistence, then removes staff without losing the flag. Separate API tests prove allow/deny behavior for the existing active session.
- No response fixtures, production accounts or real emails used in the browser check.

## Release boundary

Changes require a fresh review of this updated head and CI. Apply additive migration 010 using normal deployment procedures and verify production admin/member access after an authorized deployment. Keep database backups; do not reverse additive schema by deleting account/session data. Existing header overlap, waiver-dialog layering and confirmation branding issues are not resolved here. Instructor-plus-customer policy remains the conservative literal ticket interpretation, documented in `rbac.md`.
