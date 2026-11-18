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

## Applying migrations 045 to 052

1. Pause automatic cutover using the existing [pause procedure](AUTO-DEPLOYMENT.md#pause-recover-and-retry).
   Leave the previous release serving and take fresh, readable public and demo
   backups through the reviewed owner process. Use the exact candidate revision.
2. Run the candidate's `node backend/dist/scripts/migrate.js` with the owner
   connection for each database from the release image. This applies all eight
   files, from `045_reader_setup_again.sql` through
   `052_studio_hold_reconcile_backoff.sql`, including `051_desk_check_in_origin.sql`.
   Use the runner so the replacement setup index is built before the swap and
   the lease expiry and refund indexes are built after the schema commits. The
   runner builds these indexes concurrently on live tables. It also validates
   the check-in constraint while writes continue and clears previously sent
   notification links in separate batches. A reader trigger swap fails
   immediately if its lock is busy. Other schema lock waits in this batch are
   capped at 250 ms per lock. On a lock conflict, retry in a quieter period.
   After an interrupted build or cleanup, rerun the same command to finish it.
3. On each database where the runtime role lacks either privilege, grant both
   as owner for the new reader lease compaction job.

   ```sql
   GRANT UPDATE, DELETE ON app_device_access_event TO <runtime role>;
   ```

   Substitute the database's actual runtime role. A table owner already has
   both privileges. These migrations add no tables or sequences. The desk
   check-in uses the runtime role's existing check-in insert privileges. The
   payment and studio columns use existing table grants.

4. Run `node backend/dist/scripts/verify-migrations.js` from the same image
   against both databases using owner connections. Require it to pass before
   resuming cutover. The automated deployer's checksum check can see the
   numbered migrations as applied while the online work is still running.
   After verification, resume using the existing release procedure.

## Verification

`node --test deploy/rles-edge.test.mjs` exercises atomic route flips, in-flight
requests, signed reader bytes, restricted asset fallback and fail-closed routing.
`python3 deploy/test_blue_green_release.py` covers standby/demo/backup/CI faults,
live rollback, interrupted activation recovery, configuration preservation and
stale retirement timers. Existing deployment, reader, application, launcher and
sponsor verification gates remain required.
