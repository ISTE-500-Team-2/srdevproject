# Shared reader access readiness

The staff website's account status and staff restriction are not equipment access grants. An active account can still fail card, membership/day-pass, waiver, training, resource availability or reservation checks.

## Shared decision path

`evaluateReaderAccess` in `backend/src/services/ReaderEligibility.ts` is the unchanged evaluator extracted from the signed device route. Both that route and the staff preview call it within the existing bounded access transaction. The Orange Pi continues to obtain a fresh signed-device decision; the ESP32 is not given independent business rules.

Staff can use **Members → select a member → Reader access readiness**, or **Reader access → select a member**, then choose a configured reader. The panel shows Ready to use, Blocked with the first blocking requirement, or Not verified. Remaining checks run once an earlier blocker is resolved; this is not an exhaustive prerequisites checklist.

## Preview API

`GET /api/admin/users/:id/access-readiness?readerId=<configured-id>`

- Requires a signed-in staff/admin account and global user-read permission. Member/instructor self-service is not added.
- Defaults to the first configured reader; includes only safe reader ID, kind, target ID and resource name metadata.
- Requires at least one active assigned card. The preview concerns any active assigned card; a revoked/unknown card will still fail at the reader.
- Returns user ID, safe reader metadata, reader ID, active-card presence, allowed/reason, checked time and snapshot expiration. No raw UID, card hash, reader secret, member email, check-in ID, event ID, device command or lease payload is returned.
- `Cache-Control: no-store`. Configuration failures and verification timeouts are unavailable/unknown, not grants.
- Creates no card, membership, booking, check-in, device-access event or audit record. Does not activate equipment, sign agreements, change restrictions or add override permissions.

The UI refreshes every three seconds while not editing. Ready snapshots expire within the backend validity window (at most five seconds), failed refreshes remove green readiness, and switching readers does not reuse another target's result. Historical tap records remain separately identifiable. An actual tap always re-evaluates access; the preview cannot authorize it.

The member status forms also adopt the committed server revision before showing success, preventing a rapid second save from using the revision preceding the first save. Concurrent staff changes still require review rather than automatic overwrite.

## Verification

- Real PostgreSQL/Express integration tests compare preview outcomes with signed Pi requests for ready access, no active card, suspended/inactive accounts, missing entitlement, valid day pass, missing/expired waivers, revoked training, missing reservation and unavailable equipment. Resource-specific parity includes room versus machine checks.
- Before/after row hashes across nine business/event/audit tables verify preview requests do not change data. Tests cover anonymous/member denial, input validation, safe metadata, missing configuration and lock-contention timeout behavior.
- React tests cover backend blocker presentation, expiration, failed refresh, target switch, revision refresh and rapid consecutive status saves. Existing full application suites also run.

No schema migration, firmware change or production data/configuration change is required. This PR is not a production rollout or physical relay acceptance result.
