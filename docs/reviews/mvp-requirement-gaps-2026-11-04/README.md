# MVP requirement gaps: code fixes

Based on `main` at `1739c8d`. Closes or narrows the code gaps found when checking the Oct 28 requirements sheet against the code. Sponsor, hardware and evidence items from that check are not part of this change.

## What changed

| Requirement | Change |
| --- | --- |
| FR-032 | Health checks queue issue and recovery notices for active staff and admins when an enabled, set-up reader has stopped reporting for more than 5 minutes, then returns. Admins can queue notices for active accounts about other issues and fixes from **Service notices**. Delivery follows the worker schedule and respects opt-out. |
| FR-033 | A handled delayed day-pass payment failure queues a deduplicated notice when the checkout is still pending. Sending depends on the email runtime and opt-out. |
| FR-057 | Members can cancel a currently running, active membership with no linked billing invoice. It ends 30 elapsed days from the request, or on its existing end date if sooner, and counts as cancelled in reports. Refunds stay with staff. |
| FR-073 | Analytics and Reports show the number of memberships active right now. |
| FR-076, FR-079 | Class seats and rosters poll every 15 seconds while visible, without pending requests, writes or unsaved edits. Real-time freshness acceptance remains unresolved. |
| B-014 | Active training records with no expiry date are dated only when their certification has a validity period. Expiry uses the training date, or today if none was recorded, plus that period. This runs in the migration and when an admin sets a validity period; existing expiry dates stay unchanged. |
| B-015 | Admins can give a waiver a duration when publishing it. Each new signature then expires that many days later. |
| BR-010 | New reminders for records granted with a week or less left are excluded from the on-time metric. Short-lived waiver reminders queue at signing; other records rely on scans, and manual waiver expiry uses the assignment time. Existing pending reminders keep their SLA flag. Queueing does not mean immediate sending or satisfy a week of notice. |

## What stays Partial

- **FR-032:** automatic notices cover silent readers, not every system issue. Other issues need a manual notice; a whole-site outage needs outside monitoring.
- **FR-057:** scheduled and suspended desk memberships cannot be cancelled by the member.
- **FR-076, FR-079:** seats and rosters are available, but acceptance of conditional polling as real-time remains unresolved.
- **B-013:** Reports names available machines with no training requirement, but booking them is still permitted. Undated training can also remain eligible. Reporting does not enforce certification coverage.
- **B-014:** active records whose certification has no validity period stay undated; not all certifications have a duration.
- **B-015:** duration remains optional and unset by this change. Existing signatures are unchanged, and admins can still clear individual expiry dates.
- **B-016:** Reports counts only currently approved signatures missing a retained copy with the expected payload keys. It does not count unapproved historical signatures, validate full copy integrity or restore missing copies. Whether to ask those members to sign again is a separate decision.
- **BR-010:** excluding impossible notice windows from the metric does not meet the literal one-week notice rule. Existing pending reminders may retain their earlier SLA flag.
- **FR-061:** covered business changes are stored, but literal “all changes” remains Partial. Reasons stay out of the audit API on purpose (`ffb6437`, `2e4f89c`, enforced by `primary.test.ts`), so showing them in the Change log would reverse that decision. Routine reader heartbeats and replay counters are also deliberately not logged, so the sheet's "all changes" wording needs that exception.

## Limits

- FR-032 can only report what a running server can see. If the whole site or its database is down, nothing here can send an email, so that case needs outside uptime monitoring.
- Automatic reader monitoring as well as sending only runs with `EMAIL_ENABLED=true` and valid email configuration. Legacy canaries disable email; blue/green standby candidates preserve the public email setting and can run monitoring before promotion.
- A successful health check queues one issue notice per open outage for enabled, set-up readers whose recorded last-seen time is over 5 minutes old. Never-connected readers are excluded. Recovery closes the outage; a later outage can create another notice.
- A broadcast queues all recipients in one transaction. The prior local concurrency report measured about 4.3 seconds for roughly 5,000 recipients, during which some staff writes waited; this is not a production timing guarantee.
- `backend/src/services/StaffService.ts:461` has an existing nested pool query inside a transaction. The prior concurrency check reproduced exhaustion with a 20-connection pool. This is unrelated to this change and is not fixed here.
- `.github/workflows/sql-verify.yml` does not trigger for migration 035. Its path filters include only migration 005, not migration files generally. MVC integration still exercises migrations.

## Release

This branch does not apply anything to production. Automatic release refuses until migration 035 is applied and recorded with the matching checksum.

1. Before migrating, preview the B-014 effect on the database: active records with no `renewaldate` whose certification has a validity period, and how many would land in the past. **Affected members fail later authorization checks for that equipment after the migration commits.** This is not an instant physical cutoff of an existing reader lease.
2. Apply `035_mvp_requirement_gaps.sql` through the owner migration runner on both the public and demo databases. It adds schema objects and backfills the B-014 dates and revisions.
3. Grant the runtime role DML on `app_service_notice` and USAGE/SELECT on `app_service_notice_id_seq`. The prior local rehearsal needed no other new grants with its existing runtime privileges and default function ACLs; production privileges were not inspected.
4. Release the application through the immutable-image workflow.

Rollback: restoring the previous image does not undo backfilled certification dates, membership end-date changes or sent emails. The change-capture trigger records mutation metadata, not old date values, so it cannot restore those dates. The old image will not apply per-waiver validity when signing; new signatures can have no expiry even on a waiver published with a duration.

## Verification

Coverage is in `backend/test/integration/mvp-requirement-gaps.test.ts` and the matching frontend tests. This docs-only correction checked current source and prior reports; no application tests, builds, real email, reader or Stripe payment checks were run.

Local tests: seven backend integration tests can fail if Docker PostgreSQL's clock leads Node's, as reproduced in the prior local verification. All 36 tests in the five affected files passed with a scratch clock-alignment preload. These results were not rerun for this correction; clock skew can still affect local boundary tests.
