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

## Applying migrations 045 to 054

1. Pause automatic cutover using the [pause procedure](AUTO-DEPLOYMENT.md#pause-recover-and-retry).
   Leave the previous release serving. Take fresh public and demo backups and
   check both archives with `pg_restore --list`. Review the numbered SQL and its
   companion [online code](../backend/src/scripts/online-migrations.ts) at the
   exact candidate revision.
2. On each database, use the server's guarded reviewed-migration script as the
   owner to apply and record the exact checksums for all ten numbered files
   from `045_reader_setup_again.sql` through `054_notification_worker_compatibility.sql`.
   Serialize migration work using the existing session advisory lock
   `pg_advisory_lock(hashtext('arbor-mvc-migrations'))`. In the schema transaction,
   set `SET LOCAL lock_timeout = '250ms';` before applying this batch. Migration
   048 takes the reader table lock with `NOWAIT`, as does 054 for the outbox.
   Migration 053 only adds nullable columns and adjusts audit triggers in this
   transaction. A busy lock can abort the schema batch with SQLSTATE `55P03`.
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
   lease expiry index, the unique refund index and both checkout reconciliation
   indexes. It validates the check-in constraint, removes the refund write guard
   once uniqueness is enforced, scrubs previously sent notification links and
   queues legacy checkout refund work in committed batches. It records the
   refund backfill completion in the migration ledger.

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
   paused until both verifications pass and the grants are in place. Then use
   the [resume procedure](AUTO-DEPLOYMENT.md#pause-recover-and-retry).

Migration 054 takes a brief exclusive outbox lock to add a nullable column and
install its queue trigger. It leaves the existing due index in place and does
not scan or rewrite outbox rows. If 054 cannot get its lock immediately, the
migration transaction rolls back. Retry through the owner migration process
during a quieter interval. Rehearse the complete migration batch against a
restored backup, including the online phase.

On an application rollback, keep all applied migrations in place. The previous
worker continues to send compatible mail and can still obsolete queued resets,
apply opt-outs and count protected jobs as pending. Jobs that require the new
worker keep their original schedules and deadlines and wait for a compatible
release. A legacy pending account's reset expires 30 minutes after issuance.
If rollback outlasts the reset, the member can request a fresh one after the new
release returns. During rollback they can also use email confirmation to
activate the account and then request a reset through the previous release.

After cutover, if a Stripe checkout webhook failed around the release and its
checkout is still unresolved, resend the affected checkout event to the original
webhook endpoint from Stripe. Check the booking or pass and its payment in the
staff ledger after delivery. For a checkout already acknowledged by the previous
release, check the Stripe payment and refund records before taking any manual
action.

## Verification

`node --test deploy/rles-edge.test.mjs` exercises atomic route flips, in-flight
requests, signed reader bytes, restricted asset fallback and fail-closed routing.
`python3 deploy/test_blue_green_release.py` covers standby/demo/backup/CI faults,
live rollback, interrupted activation recovery, configuration preservation and
stale retirement timers. Existing deployment, reader, application, launcher and
sponsor verification gates remain required.
