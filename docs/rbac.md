# Roles and permissions

SDTA-119 keeps old `member` (community member) and `admin` (super administrator)
identifiers so existing clients and accounts keep working. `staff`, `subscriber`,
`day_pass`, and `instructor` can be combined with those roles. Accounts have one
`primaryRole` and an array of assigned `roles`. The legacy `role` field remains
an admin/staff/member UI compatibility projection; it is not the primary role.
Access JWTs snapshot the primary assigned role and all assignments. Authorization
reloads database assignments on every request instead of trusting stale claims.

Student status is an independent `isStudent` modifier, as specified by the project
charter. It does not grant administrative access, a membership, a discount, or a
booking exemption. Existing student assignments are retained during migration and
backfilled into the modifier. Pricing/school-billing behavior belongs to payment
policy work, not authorization.

## Editing roles

Only administrators can edit other accounts. The staff account screen selects
multiple roles, exactly one primary role from that set, and student status. The
API validates the set and optimistic revision, serializes changes, records the
before/after audit, rejects self-role changes and preserves the final active
administrator. The legacy `{role: ...}` request changes the previous primary role
but retains additional assignments; new clients send `{primaryRole, roles,
isStudent, revision, reason}`. Unknown historical classifications are not deleted.

## Route enforcement

Every protected business route has permission middleware before its controller.
Personal grants are evaluated only for the authenticated user; record ownership
is additionally checked by the existing models/services. Admin endpoints require
staff status plus the relevant global permission. Global grants never come from
request-body ownership or role fields. Explicit applicable denies override grants,
except the existing super-administrator bypass. Staff writes keep their existing
transaction-time permission and target-account checks. Equipment booking also
rechecks assignments/permissions under the locked user row.

Customer-role labels do not create paid entitlement. Existing membership/day-pass,
waiver, training, suspension, conflict, and ownership checks remain in place.
Instructor presence denies reservation creation even alongside a customer/admin
role, following BR-006 literally. Catalog availability explains this restriction.
The sponsor Q&A specifically prohibits booking on behalf of others; broader
instructor-plus-customer behavior still requires reconciliation before changing
this conservative rule. No new grant overrides that restriction.

## Source and review

- Jira SDTA-119 (primary/multiple roles and permission middleware)
- Project Charter: students are account modifiers
- Requirements: BR-006 instructor reservation prohibition
- Sponsor Q&A: instructors do not book on behalf of others

Migration 010 is additive and preserves users, credentials, sessions, role rows,
and existing permission denies. Fresh demo accounts set their primary role once;
re-running setup does not restore removed privileges. No shared database changes
are part of this PR. Studio rental routes must use the same permission middleware
and transaction-time eligibility checks when integrated.
