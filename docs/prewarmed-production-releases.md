# Prewarmed production releases

## Timing contract

Preparation (CI, image build, fresh readable backups, migration checksums, standby
startup and smoke checks, demo update) happens while the existing public release
keeps serving. `cutoverSeconds` measures the atomic public route switch **plus**
real public authentication/API/asset/anonymous-denial verification. It does not
pretend the earlier work or CI finished in that interval. The aim is under 10s for
that ready-to-verified-live phase. `preparedSeconds` and total release timing are
recorded separately in the protected release's `activation-metrics.json`.

## Authoritative routing

The owner-only `routing/active.json` is mounted read-only as a **directory** in the
existing edge, with `GATEWAY_ROUTE_FILE` pointing to its `active.json`. Example:

```json
{"version":1,"release":"<exact 40-character main revision>","publicPort":18082,"previousPublicPort":8082}
```

Only 8082 (legacy public), 18082 (green public), and 28082 (blue public) are allowed.
8081/18081/demo destinations are rejected. Missing/malformed routing fails closed.
The proxy snapshots one route for each request; signed reader bytes and identities
are unchanged. All new website and NFC API requests use that same public backend.
`X-Arbor-Release` identifies the selected revision on ordinary proxy responses.

Only a flat `/assets/<filename>` GET/HEAD returning 404 may retrieve old static
assets from the previous public release, without forwarding cookies or auth.
There is no API/access-decision fallback, and never a fallback to demo.

## Preparation and activation

Opt-in is the protected `auto-deploy/blue-green.enabled` marker. Without it the
existing release mechanism is unchanged. Enabling requires installing the checked
edge/controller source, mounting the routing directory and verifying the edge
before creating that marker. Existing service/timer/lock and six exact-main CI
checks are retained.

The standby clones only the public service's existing configuration: same public
database, JWT key, reader configuration, environment files, certificates and
notification policy. It is a separate Compose project (`arbor-public-green` or
`arbor-public-blue`) with a loopback-only slot port. No data migration, seeding,
database replacement, permission widening or volume deletion occurs. The one
addition is `TRUST_PROXY=1`, so sign-in limits count each visitor named by the RLES
edge (`deploy/rles-edge.mjs`) rather than the edge itself. Until that edge is
installed, the running gateway strips `X-Forwarded-For`, so this changes nothing
yet. To use another value, set `TRUST_PROXY` in the public service's
`environment` in `compose.json`; Compose prefers that over an environment file.

The new edge names every visitor as the front proxy (172.16.1.254) until
`GATEWAY_TRUST_FORWARDED_FOR=1` is set in its environment, so sign-in limits still
share one budget, as today. Set it only after checking on the host that the front
proxy appends the visitor's address to `X-Forwarded-For` or replaces the header
(for example, send a request through the public address with a made-up
`X-Forwarded-For: 192.0.2.1` and capture what reaches the edge: the last entry must
be your real address). If the front proxy passes the header through unchanged,
leave it unset: any visitor could then pick the address the limits count.

The app's existing outbox `FOR UPDATE SKIP LOCKED` leases and unique notification
keys coordinate concurrent public processes; uncertain provider acceptance is not
automatically resent. Policy retirement uses its existing transaction advisory
lock. No second scheduler implementation or altered notification policy is added.

After fresh backups and standby checks, demo alone is updated/verified on its
separate database at 8081. Then the deployer rechecks live config, route, pause,
current main and all CI gates immediately before atomic public promotion.

The active public process is described by `status.json`'s `publicContainer` and
`publicPort`, **not necessarily the legacy `arbor-email-app` container**. Root
`compose.json` retains its public template/keys/DB configuration; only app image
metadata changes. Do not manually use Compose to replace the active slot. Use the
release service and recorded slot's `public-slot.json`.

## Failure recovery and retention

An owner-only activation journal is written before demo/public changes. Failures
restore the old public route first, then the previous demo image/configuration.
Unrelated operator configuration changes are not overwritten. A process killed
mid-activation is recovered at the next locked release tick before new deployment.

The previous public process stays warm for 30 seconds after successful promotion
for in-flight requests and immediate rollback. A transient user-systemd timer
then drains/stops it without deleting it. Retirement rechecks the current route
and the old immutable image revision under the same deployment lock: a stale timer
cannot stop a reused or active slot. Failed timer scheduling is reported as
`retirementScheduled: false`; it does not roll back a healthy new application.
Retirement additionally requires a matching durable committed journal; a timer
left by an interrupted, uncommitted promotion cannot stop its rollback process.
Reconciliation of already-recorded committed success preserves a later failed
release's block rather than silently retrying that failed revision.

Beyond the warm window, restoration requires starting the retained old process
and proving it healthy before manually restoring its recorded route. Do not
restore database backups as an application rollback.

Schema-changing releases still require separately reviewed backward-compatible
database changes. This deployer never executes DDL; exact migration checksums
remain a hard prerequisite.

## Applying migrations 045 to 055

1. Pause automatic cutover using the [pause procedure](AUTO-DEPLOYMENT.md#pause-recover-and-retry).
   Leave the previous release serving. Take fresh public and demo backups and
   check both archives with `pg_restore --list`. Review the numbered SQL and its
   companion [online code](../backend/src/scripts/online-migrations.ts) at the
   exact candidate revision.
2. On each database, use the server's guarded reviewed-migration script as the
   owner to apply and record the exact checksums for all eleven numbered files
   from `045_reader_setup_again.sql` through `055_pending_registration_password_confirmation.sql`.
   Serialize migration work using the existing session advisory lock
   `pg_advisory_lock(hashtext('arbor-mvc-migrations'))`. In the schema transaction,
   set `SET LOCAL lock_timeout = '250ms';` before applying this batch. Migration
   048 takes the reader table lock with `NOWAIT`, as does 054 for the outbox.
   Migration 053 adds nullable columns and flags with constant defaults, and
   adjusts audit triggers. These changes do not rewrite either
   checkout table. Migration 055 adds a flag with a constant default and
   installs a `NOT VALID` constraint that applies to new writes immediately.
   The table scan for validation runs after commit. A busy lock can abort the
   schema batch with SQLSTATE `55P03`.
   Roll back and retry during a quieter period. Release the session advisory
   lock when the guarded script finishes.
3. After the schema transaction commits, run the reviewed online phase on each
   database as owner. The candidate image provides a command for this phase:

   ```sh
   node backend/dist/scripts/migrate.js --finish-online
   ```

   This mode acquires the same advisory lock, checks the numbered migration
   history, and runs only the post-commit steps. The guarded process can invoke
   this command or execute the same reviewed sequence in its own owner session.
   Use autocommit for concurrent index commands. The online phase builds the
   replacement reader setup index before removing the old one. It builds the
   lease expiry index, the unique refund index, both checkout refund due indexes
   and the index for unchecked equipment payments. It validates the check-in
   and pending-registration constraints, removes the refund write guard once
   uniqueness is enforced, scrubs previously sent notification links and queues
   legacy checkout refund work in committed batches. It records the 053 backfill
   checkpoint in the migration ledger. For 055, PostgreSQL records validation
   in the constraint catalog.

   Retry this phase after a lock conflict, interrupted build or incomplete
   cleanup. It reuses matching valid indexes and rebuilds matching invalid
   indexes. If an index definition differs from the reviewed definition,
   investigate before retrying.
4. On each database where the runtime role lacks either privilege, grant both
   as owner for the reader lease compaction job.

   ```sql
   GRANT UPDATE, DELETE ON app_device_access_event TO <runtime role>;
   ```

   Substitute the database's actual runtime role. A table owner already has
   both privileges. Desk check-in, payments and studio reconciliation use
   existing table grants.
5. Run `node backend/dist/scripts/verify-migrations.js` from the candidate image
   against both databases. Keep the candidate application stopped and cutover
   paused until both verifications pass and the grants are in place. Install the
   matching `auto_release.py` on the release host before resuming. Before any
   standby starts, it uses the existing database owner connections to require
   the checksum-matched 053 backfill checkpoint, removal of the equipment refund
   write guard, and validation of the 055 pending-registration constraint in both
   databases. The gate needs no new host configuration. Then use the [resume procedure](AUTO-DEPLOYMENT.md#pause-recover-and-retry).

Migration 054 takes a brief exclusive outbox lock to add a nullable column and
install its queue trigger. It leaves the existing due index in place and does
not scan or rewrite outbox rows. If 054 cannot get its lock immediately, the
migration transaction rolls back. Retry through the owner migration process
during a quieter interval. Rehearse the complete migration batch against a
restored backup, including the online phase.

Before rolling back past the release that added studio readers, turn every
studio reader off first; see the studio reader step in
[AUTO-DEPLOYMENT.md](AUTO-DEPLOYMENT.md#pause-recover-and-retry).

On an application rollback, keep all applied migrations in place. The previous
worker continues to send compatible mail and can still obsolete queued resets,
apply opt-outs and count protected jobs as pending. Jobs that require the new
worker keep their original schedules and deadlines and wait for a compatible
release. A legacy pending account's reset expires 30 minutes after issuance.
If rollback outlasts the reset, the member can request a fresh one after the new
release returns. During rollback they can also use email confirmation to
activate the account and then request a reset through the previous release.

For staged sign-ups created, replaced or resent by the new release, the previous
release may deliver a queued confirmation email, but it rejects the link and
cannot resend a usable link for that request. Those sign-ups can resume when the
password-aware release returns. If the request has expired by then, the member
must sign up again. Older staged sign-ups left untouched by the new release
retain their previous confirmation behavior during rollback.

After the previous release has stopped handling webhooks, review Stripe deliveries
from the start of the online backfill through the end of that overlap. The new
release's equipment worker continues checking paid checkouts that the previous
release confirmed without queuing a refund lookup. It processes bounded batches
and backs off failed lookups.

Resend failed checkout events for unresolved payments to the original webhook
endpoint. Also resend refund events for affected payments that the previous
release acknowledged, including refunds arriving after a standby worker already
checked the payment. If both events need replay, resend checkout first to bind the
payment intent. Compare the Stripe payment and refund records with the staff
ledger after delivery. Replay records the existing refund. Do not create another
refund to repair the ledger. Repeat this review for any period when an application
rollback handled webhook traffic.

For day passes, the previous release can return HTTP 409 for a paid retired
Checkout Session or a refund that covers only part of the original charge. The
new worker checks retired sessions in Stripe and monitors partial refunds for
three days after staff honor the visit. If a refund is still pending or requires
action at the cutoff, monitoring continues until it settles. The worker checks
those refunds daily after 30 days. Keep the failed-delivery replay step after the
previous release drains, even if the worker has already resolved some payments.

Also check successful Checkout deliveries using the query below. A distinct
completion can make the previous release issue a pass after a full refund or
issue one for a retired replacement. The compatible worker flags these active
passes and duplicate ledger entries for staff review in **Payments**. Run the
query while the compatible worker is stopped.

### Captured day-pass payments during rollback

Run the [read-only day-pass query](../database/fixes/list-day-pass-rollback-payments.sql)
against each affected database as soon as the previous release takes webhook traffic,
and at the start of each shift while it does. From the repository root, use
`psql -X -v ON_ERROR_STOP=1 -f database/fixes/list-day-pass-rollback-payments.sql`
with that database's normal operator connection. The query includes future retry
deadlines, queued checkouts, charges waiting for a pass, and checkouts flagged
for review. A flagged checkout with no ledger payment needs manual verification
in Stripe. Bounded session discovery may have reached its page limit or retry
deadline before locating a charge. Prioritize upcoming visits in date order.
Give staff the checkout ID and any ledger payment ID for follow-up.

For acknowledged deliveries, inspect `active_after_full_refund`, active rows
with `retired_by_checkout_id`, and rows with multiple IDs in
`matching_stripe_payment_ids`. The array lists ledger payments that match the
session or PaymentIntent reference, including refunded entries. Put any
incorrectly issued pass on hold and give the payments owner the checkout,
session, PaymentIntent, pass, and matching ledger IDs. Verify captured amounts
and refunds in Stripe before sending any money or correcting the ledger.

For each row, compare the Checkout Session, captured amount, and all refunds on
its Payment Intent in the matching Stripe account. If the query has a session
ID and no Payment Intent ID, open the session in Stripe to find its latest
payment state. Also check the member's day passes for that visit date.

- **Captured in full, no live refund, visit still available.** Restore a compatible
  release so its worker can resume queued charges. For a charge already flagged
  in Payments, use **Review refund** and **Honor the visit** to issue the pass
  against the existing payment after Stripe verifies the charge.
  If the member arrives during rollback, staff can verify waivers and eligibility
  and admit them without taking
  another payment if facility policy permits. Record the admission and checkout
  ID in the shift log. The compatible release can link the original charge
  to a pass while the visit is still available.
- **Visit ended.** Leave the captured charge for staff review. The compatible
  release holds the charge if the member may have been admitted during
  rollback. Check the shift log and the Stripe payment before using **Review
  refund** in Payments. Completing review links the payment to a cancelled pass
  as a record of the closed visit. Keep the payment if the shift log confirms
  admission. Use **Refund** after review if the unused visit is owed a full refund.
- **Visit still available and a separate pass already exists.** The compatible
  release can refund the duplicate charge when Stripe shows no live refund.
  Verify the existing pass and original charge in the ledger after recovery.
- **Refund already pending, partial, or complete.** Compare all refunds against
  the original charge. The compatible release cancels access as soon as Stripe
  confirms the full refund, including one paid in parts. Payments retains any
  review flag until staff complete **Review refund**. Choose **Honor the visit**
  to issue an eligible held pass after verifying the retained charge in Stripe.
  For an overlapping pass already issued by the previous release, a confirmed
  full refund cancels the pass and corrects the ledger. If the replacement visit
  should stand, select **Honor the visit** to record approval for that payment
  and pass. To refund a replacement instead, refund it in Stripe and complete
  review after the refund settles.
  Escalate unclear cases to the payments owner and record the Stripe IDs and
  confirmed amounts for follow-up. Keep a single operator
  responsible for resolving the payment.

The previous webhook acknowledges an event ID already stored in
`app_pass_stripe_event` without processing it. The new release can store that
ID and queue the Checkout Session before its refund lookup succeeds. Resending
the same event to the previous release leaves the session queued. Its worker
cannot process the queue. Replay to the previous release can reach its handler
only for an event whose ID has not already been stored. Use the compatible webhook
or worker to finish queued events. The compatible webhook resumes queued work
on duplicate Checkout deliveries while a retry deadline remains. When the
retry window ends or the refund lookup returns a terminal error, the compatible
release records a verified capture in Payments with **Review refund**. Use
that action rather than replaying the event. A flag without a ledger payment
means session discovery could not verify a capture. After a capped search the
worker retries pending checkouts hourly. Once the session window has passed, a
complete search that finds no session lets the worker expire the checkout.
Finance can match a checkout to a Stripe session and recover a capture from
the corresponding paid event.
Keep event receipts intact. When the compatible release returns, rerun the
query and verify each open item against Stripe and the staff ledger, including
any manual admissions or refunds.

## Verification

`node --test deploy/rles-edge.test.mjs` exercises atomic route flips, in-flight
requests, signed reader bytes, restricted asset fallback and fail-closed routing.
`python3 deploy/test_blue_green_release.py` covers standby/demo/backup/CI faults,
live rollback, interrupted activation recovery, configuration preservation and
stale retirement timers. Existing deployment, reader, application, launcher and
sponsor verification gates remain required.
