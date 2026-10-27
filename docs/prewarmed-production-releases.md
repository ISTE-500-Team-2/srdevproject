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
database replacement, permission widening or volume deletion occurs.

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

Beyond the warm window, restoration requires starting the retained old process
and proving it healthy before manually restoring its recorded route. Do not
restore database backups as an application rollback.

Schema-changing releases still require separately reviewed backward-compatible
database changes. This deployer never executes DDL; exact migration checksums
remain a hard prerequisite.

## Verification

`node --test deploy/rles-edge.test.mjs` exercises atomic route flips, in-flight
requests, signed reader bytes, restricted asset fallback and fail-closed routing.
`python3 deploy/test_blue_green_release.py` covers standby/demo/backup/CI faults,
live rollback, interrupted activation recovery, configuration preservation and
stale retirement timers. Existing deployment, reader, application, launcher and
sponsor verification gates remain required.
