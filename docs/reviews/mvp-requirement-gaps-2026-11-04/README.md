# MVP requirement gaps: code fixes

Based on `main` at `1739c8d`. Closes or narrows the code gaps found when checking the Oct 28 requirements sheet against the code. Sponsor, hardware and evidence items from that check are not part of this change.

## What changed

| Requirement | Change |
| --- | --- |
| FR-032 | The server emails staff and admins when an enabled, set-up reader stops reporting for 5 minutes, and again when it returns. Admins can also email everyone about any other issue and its fix from **Service notices**. |
| FR-033 | A failed delayed day-pass payment now emails the member. |
| FR-057 | Members can cancel a membership with no card subscription behind it. It ends 30 days from the request, or on its existing end date if sooner, and counts as cancelled in reports. Refunds stay with staff. |
| FR-073 | Analytics and Reports show the number of memberships active right now. |
| FR-076, FR-079 | Class seats and rosters refresh every 15 seconds instead of every 2 minutes. This is frequent polling, not instant push. |
| B-014 | Active certifications with no expiry date are dated from their training date, or from today if none was recorded. This runs in the migration and whenever an admin sets a validity period. |
| B-015 | Admins can give a waiver a duration when publishing it. Each new signature then expires that many days later. |
| BR-010 | A record granted with under a week left still gets its reminder straight away, but no longer counts as a missed deadline, because a week's notice was impossible. A reminder that is late for any other reason still counts. |

## Built, but needs a decision before it closes

- **B-013:** Reports now names every bookable machine with no training requirement. Booking is not blocked, because that would make every unlinked machine unbookable until the sponsor confirms which machines need training. Link certifications first; requiring one on every machine is a small follow-up.
- **B-015:** no duration is set, because the sponsor hasn't chosen one. Until an admin publishes a version with a duration, waivers keep not expiring on their own. Existing signatures are not changed.
- **B-016:** Reports now counts signatures with no retained copy. Whether to ask those members to sign again is a separate decision.
- **FR-061:** no code change. Changes are already stored, and that is what the requirement asks for. Reasons stay out of the audit API on purpose (`ffb6437`, `2e4f89c`, enforced by `primary.test.ts`), so showing them in the Change log would reverse that decision. Routine reader heartbeats and replay counters are also deliberately not logged, so the sheet's "all changes" wording needs that exception.

## Limits

- FR-032 can only report what a running server can see. If the whole site or its database is down, nothing here can send an email, so that case needs outside uptime monitoring.
- Reader alerts need email enabled (`EMAIL_ENABLED=true`), so they do not run in canary or blue/green candidates.
- The first run alerts staff once for each enabled reader that is already silent.

## Release

This branch does not apply anything to production. Automatic release keeps refusing until the migration is present.

1. Before migrating, preview the B-014 effect on the database: certifications with a validity period, active records with no `renewaldate`, and how many would land in the past. **Those members lose access to that equipment as soon as the migration runs**, which is correct under B-013 but may surprise them.
2. Apply additive `035_mvp_requirement_gaps.sql` through the owner migration runner on both the public and demo databases.
3. Grant the runtime role DML on `app_service_notice` and USAGE/SELECT on `app_service_notice_id_seq`. No other new grants are needed.
4. Release the application through the immutable-image workflow.

Rollback: restore the previous image. The migration is additive apart from the B-014 dates, which are recorded by the change-capture trigger on `user_certifications`.

## Verification

See the pull request for the commands and results. New coverage is in `backend/test/integration/mvp-requirement-gaps.test.ts` and the matching frontend tests. No real email, reader or Stripe payment was used.
