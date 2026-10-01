# PR #26: scheduling fixes and database compatibility

This document covers fixes to [PR #26](https://github.com/ISTE-500-Team-2/srdevproject/pull/26),
reviewed at `8ac408f3375067368c552e1652c188021241e34a`. It describes the final rules,
their sources, the migration design, regression coverage, and rollout procedures.
Implementation and verification status appears at the end. This is not a claim
that the shared RLES database or hosted application has been upgraded.

## Problems and resulting behavior

| Review finding | Previous behavior | Fixed behavior |
| --- | --- | --- |
| Upgrade fails on valid bookings | Building a 15-minute exclusion over existing adjacent bookings raises `23P01` and rolls back migration. Historical confirmed bookings also qualify. | Grandfather existing bookings; enforce the new policy on new, rescheduled, reassigned, or reactivated bookings. |
| Members cannot discover rooms | `/api/rooms` requires `room:read`, but no grant is seeded for customer or staff roles. | Seed personal catalog-read grants while preserving explicit denies. |
| Long room details deny check-in | Combining two valid 100-character room fields exceeds `check_in.location`'s 100-character limit and returns HTTP 500. | Store the complete name, separator, and location in a 203-character field. |
| Equipment has no downtime between different users | The 15-minute check is limited to the same user, allowing another member to start immediately. | Equipment bookings require 15 minutes between any users of the same machine. |

## Policy and source traceability

- [Team Arbor — Requirements List](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit):
  BR-007 caps cooldown at one hour; it does not specify 15 minutes or per-user scope.
  BR-005 and FR-037 require reservation-based room access. BR-006 prohibits instructor booking.
- [Sponsor interview notes](https://docs.google.com/document/d/1kg8bFolDIC-LfMnr-E-P60TvwbNEBpkvcJRD-iSaW50/edit):
  the equipment cooldown discussion describes setup/downtime between uses, supporting machine-wide scope.
- [Crafty Studio Management System](https://docs.google.com/document/d/1UghaRRYSchQ9aTCrcmRHBvOpazhE_ulsOKVTkv_pus0/edit):
  anticipates cooldown between reservations, no longer than one hour.
- [Use Cases](https://docs.google.com/document/d/1ivzrEd9E1mOIvG0llNb8ptt4l26qe7HpIP3UzzUibGM/edit)
  and [System Architecture](https://docs.google.com/document/d/1CeyE5pD_pmIZr6uXAO0zj9VhvVfYmsID3w42Trb4ly4/edit)
  were checked during review for booking, eligibility, and access behavior.

The user selected equipment-wide scope during planning and approved implementation.
The 15-minute duration is retained from the PR, within BR-007's ceiling; it is an
implementation decision, not a newly attributed sponsor requirement. Room cooldown
remains the PR's existing 15-minute rule between the same user's bookings of the
same room. This change does not reinterpret room cooldown as cleaning time.

| Resource | Overlap | Cooldown | Boundary |
| --- | --- | --- | --- |
| Equipment | Blocked across users | 15 minutes across users of the same machine | Exactly 15 minutes is allowed, before or after an existing booking. |
| Room | Blocked across users | 15 minutes for the same user and room | Different users may book adjacent times; exactly 15 minutes is allowed for the same user. |

Only `confirmed` and `pending` bookings occupy a resource or require cooldown.
Cancelled bookings release the slot. Entitlement, account access, equipment training,
waiver checks, staff-on-behalf booking rules, ownership, and cancellation notice remain in force.

## Compatibility migration

`database/migrations/010_room_reservation_compatibility.sql` sorts immediately before
`010_room_reservation_conflicts.sql`. The runner scans every migration filename,
checks each ledger entry, and runs unapplied files; it does not use a numeric
high-water mark. A newly added earlier filename therefore runs even when later
migrations have already been applied.

The original migration is byte-for-byte unchanged. Its SHA-256 is
`93c890882c806560250651e8c037c0db76f94544267f8b5e58ff98b454a82def`.
No applied checksum is edited and no checksum exception is added to the runner.
Run the normal migration runner, not the original SQL file by itself.

| Starting database | Upgrade path |
| --- | --- |
| Fresh disposable database | Create the baseline schema, then apply all migrations in filename order. Compatibility prepares the corrected constraints before the original PR migration. |
| Current main / pre-PR database | Compatibility creates room support and preserves old bookings; the original migration adds its remaining indexes and room overlap protection. |
| Original PR already applied | Compatibility replaces the old cooldown constraints; the original migration is skipped using its existing ledger entry and unchanged checksum. |
| Previous migration attempt failed | The transactional runner rolled back its changes; retry through the fixed runner after backing up the database. |
| Fixed migration already applied | The ledger makes subsequent runs skip the migration; repeat setup preserves data and history. |

All migration work runs in the existing transaction under the migration advisory
lock. Schema locks keep concurrent writes out while bookings are classified.
On an already-upgraded database, the room sequence retains its next unused ID,
including when earlier allocated IDs no longer have a corresponding room row.
The original cooldown constraint names are deliberately retained: the original
migration checks those names before creation, and the HTTP error handler recognizes
them. `app_equipment_reservation_user_cooldown` now enforces equipment-wide scope
despite its historical name.

### Grandfathering and direct database writes

The internal `reservation.cooldown_enforced` column is `false` for rows present at
upgrade and defaults to `true` afterward. It is not an API input or response field.
IDs, owners, start/end times, statuses, and existing audit records are preserved.
Existing resource-less legacy records are readable and cancellable; the conditional
resource check preserves them without permitting new resource-less reservations.

A `BEFORE INSERT OR UPDATE` trigger overrides attempts to write the flag directly:

- Inserts are always enforced.
- Changing owner, equipment, room, start, or end activates enforcement.
- Moving from an inactive status to `confirmed` or `pending` activates enforcement.
- Metadata edits and cancellation do not invalidate an unchanged grandfathered booking.
- Once enforced, a row cannot become exempt again.

Partial GiST exclusions protect enforced bookings against concurrent enforced
bookings. The trigger checks enforced bookings against grandfathered active rows.
Grandfathered blockers can only remain unchanged or cease being exempt/active;
concurrent writers cannot introduce new exempt blockers. This combination preserves
old conflicting pairs while preventing a new or changed booking from bypassing them.
Application prechecks include both grandfathered and enforced rows.

An old conflicting pair can be cancelled, but restoring or changing a booking must
satisfy the current rules. There is no automatic cancellation, rescheduling, or
bulk historical status rewrite. No separate legacy-data cleanup is required to upgrade.

### Room grants and check-in storage

Personal `room:read` grants are inserted for `member`, `subscriber`, `day_pass`,
`instructor`, and `staff`. `ON CONFLICT DO NOTHING` retains an existing deny.
The existing administrator bypass remains. Student classification alone adds no
grant. Reading the catalog does not grant booking permission or entitlement;
instructors can discover rooms but remain prohibited from creating reservations.

The migration widens `check_in.location` to `VARCHAR(203)` for two 100-character
fields and ` - `. Room identity remains in `roomid`. Labels are not truncated.
Building check-in retains its existing 100-character request validation.

## API and error behavior

No request or response shape changes. Equipment cooldown prechecks now consider
other users, and the reservation page explains the equipment-wide gap.

- Actual overlap returns HTTP 409 `RESERVATION_CONFLICT`.
- A non-overlapping gap below 15 minutes returns HTTP 409 `RESERVATION_COOLDOWN`.
- Missing room catalog permission returns HTTP 403 `PERMISSION_REQUIRED`.
- Room check-in still requires an available room, an active matching reservation,
  active account access, current entitlement, and signed required waivers.
- Database cooldown violations use `23P01` and the recognized constraint name,
  retaining the existing HTTP 409 mapping for concurrent writers.

## Verification and reproduction

`backend/test/integration/reservation-review-regressions.test.ts` builds actual
pre-PR and original-PR schemas and migration ledgers in disposable databases.
It exercises preservation of historical/future bookings and denies, unchanged
original checksums and room sequence allocation, reruns, grandfathered overlap/cooldown, cancellation and
reactivation, reassignment/rescheduling, attempted flag bypass, direct SQL races,
room catalog roles, and maximum-length Unicode room check-in.

`backend/test/integration/mvc.test.ts` tests concurrent HTTP booking, equipment
cooldown across members and the exact boundary, and retains room access coverage.

From the repository root, with explicit connection settings for an isolated
PostgreSQL test server and no `DATABASE_URL`:

```bash
npm ci --prefix backend
npm ci --prefix frontend
npm run check --prefix backend
npm run check --prefix frontend
npm run test:integration --prefix backend
npm run test:integration --prefix frontend
```

The integration harnesses create and drop their own uniquely named databases.
They require a test account with database-creation privileges. Real email delivery
and external payment processing are not enabled by these tests.

## Rollout and recovery

1. Verify the reviewed commit and migration ledger on the intended environment.
2. Back up the target database and retain the prior application artifact. Record
   reservation counts and the original migration checksum if already applied.
3. Stop booking writes during the rollout. Install the new application artifact
   and run `npm run migrate --prefix backend` using the intended database settings.
   Do not run destructive DDL or demo initialization against a shared database.
4. Verify the compatibility ledger entry, unchanged booking records and original
   checksum, the room-read grants, and 203-character check-in storage.
5. Resume the application and verify room discovery and check-in, equipment
   cooldown errors, and the exact 15-minute boundary. Check for new 500 responses
   and migration/checksum errors in the existing logs.

If migration fails, the transaction rolls back; resolve the cause and retry.
For an application rollback, retain the additive schema and database guards;
the previous PR API uses the same wire shapes, and database cooldown enforcement
remains active. Do not remove triggers/constraints, narrow the location column,
delete bookings, or restore a backup blindly. Coordinate any database restoration
so bookings written after the backup are not silently lost; prefer a forward fix.

## Implementation and verification status

Verified October 1, 2026 on the PR's local `scheduling` branch with Node 22.23.3
and an isolated Homebrew PostgreSQL 16.15 server. CI uses PostgreSQL 16.14;
remote CI must still validate the published revision when it is pushed.

| Check | Result |
| --- | --- |
| Backend TypeScript build and unit suite | Passed; 32 unit tests. |
| Frontend unit suite and production build | Passed; 34 tests across 8 files. |
| Complete backend integration suite | Passed; 106 tests, including 6 new regression tests. |
| Frontend integration suite over real Express HTTP/PostgreSQL | Passed; 19 tests across 7 files. |
| Development launcher unit suite | Passed; 4 tests. |
| Compiled application HTTP smoke | Passed: built frontend served, member room catalog returned 200, different-member adjacent equipment booking returned 409, exactly 15 minutes returned 201, and full-length Unicode room check-in returned 201. |
| Original migration SHA-256 | Unchanged; matches the checksum recorded above. |
| Whitespace/diff integrity | Passed. |

Total: **195 automated tests passed**, plus both production builds and the compiled
application HTTP smoke. Every regression database was created and dropped by its
test harness. The earlier review reproduction script remains untracked and is not
part of the implementation commit.

Docker image build, container recreation, and Docker launcher smoke were not run
because no Docker daemon was available on this host. These remain checks for the
existing CI workflow. No container, shared database, hosted application, Google
Drive document, or remote PR branch was changed during local verification.
