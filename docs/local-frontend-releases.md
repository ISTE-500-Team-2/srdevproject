# Warm, locally checked frontend releases

This is an **owner-invoked, opt-in operator path**, not a new webhook, public
receipt-upload API, GitHub status writer, or relaxation of the normal automatic
deployer. Hosted CI still runs unchanged. It avoids the hosted-runner queue and
the normal 60-second poll when the owner explicitly runs local checks.

## Scope and gates

Only changes under `frontend/src/` and `frontend/test/` since an exact, fully
CI-green main baseline qualify. Every other tracked Git object **and file mode**
must match: backend, database, dependencies/locks, build configuration, Dockerfile,
launcher, deployment tools, workflows and hosting scripts. Any such change uses
the normal full-check path. A rename out of those directories also fails closed.

The warm Mac runs, concurrently:

- `npm run test --prefix frontend -- --maxWorkers=4 --pool=threads` (all unit tests).
- `npm run build --prefix frontend` (TypeScript and Vite production build).
- `npm run test:integration --prefix frontend -- --maxWorkers=6 --pool=threads` (the complete real Express +
  disposable local PostgreSQL browser integration suite).
- Exact-main Docker image preparation on the production host, without promotion.

CI metadata is read freshly through the owner's existing local `gh` login over a
temporary loopback-only SSH reverse tunnel. Only this repository's exact-revision
check-runs and main-push workflow GETs are permitted; arbitrary URLs/repos/user
data and all writes are rejected. No GitHub token is retrieved, printed, copied
to the server or placed in command arguments/URLs. No status-response cache or
invented GitHub status is used. Missing tunnel/provider access fails closed; the
tunnel and local HTTP listener close at the end of the command.

All lanes must succeed; the checkout must remain pristine and identical before
and after. The receipt records the exact main revision/tree, Node/platform,
command/results, timings, completion time and log SHA-256 hashes. It expires after
15 minutes. Only the authenticated owner's existing SSH access can put it in the
private operator directory. It is evidence from a trusted workstation, not a
cryptographic attestation against a compromised workstation or server account.
Worker limits avoid two concurrent Vitest processes oversubscribing the same Mac;
the thread pool reduces process-spawn overhead while retaining Vitest's default
per-file isolation. Neither change selects fewer files or assertions.

The host checks the receipt and source again, verifies the baseline's exact-main
GitHub Actions checks/workflows are **still** successful, and refuses any latest
failed/cancelled/timed-out/skipped candidate check. Missing/queued candidate jobs
do not substitute for the local tests; they are simply not the selected check
provider for this explicit invocation. Normal automation retains its original
exact-main CI policy.

The owner can replace **only a queued Mac launcher lane** with genuine local
Mac evidence for that exact revision/tree (six launcher tests and an expected
missing-email-key startup failure). The protected evidence includes Node/platform,
the two actual log hashes and explicit owner authorization. All non-Mac checks
and full main application/sponsor workflows must already have succeeded; no
failed/cancelled/skipped lane can be replaced. The fallback recognizes a pinned
launcher-workflow Git object, so it cannot cover a changed job definition.
It does not create or modify a GitHub status.

An unchanged build/hosting/launcher/server test input can reuse that baseline's
result; changed frontend behavior must pass all frontend tests again. This is
not a promise that arbitrary backend/schema/infrastructure pushes take 30s.

## Operator installation

Use a protected directory `/srv/arbor-full/auto-deploy/local-frontend-tools/`
containing reviewed `local_frontend_release.py`, `blue_green_release.py` and the
installed controller's unchanged `auto_release.py`. The normal service/timer
continues using its existing modules, not this directory. Put an exact, fully
CI-green baseline SHA in the owner-only file
`auto-deploy/local-frontend-baseline`. Changing this baseline is an operator
decision; the code still revalidates its CI at promotion.

Optional marker `auto-deploy/local-frontend-prewarm.enabled` permits the source-
scoped, exact-image **inactive** public standby to start during local tests.
The backend/dependencies/schema/config must match the checked baseline; backups
and inherited checks precede startup. No unchecked frontend is routed publicly,
no private demo process is changed, and promotion still requires every local
test/build/receipt and fresh main/check/pause/config/route validation. Client
failures request cleanup; cleanup cannot stop an active or reused slot.
`--abort-prewarm --sha <exact-sha>` safely retries interrupted cleanup.

The startup probe optimization requires Docker Engine >=25 / Compose >=2.20.2.
It preserves the exact health command, regular interval, timeout and retry policy;
it defaults **only otherwise-unconfigured startup** to a 500ms probe during a
10s startup period. Healthy status is never forced, and compose `--wait` plus all
authenticated smokes remain mandatory. Explicit startup settings and disabled
health checks are not overwritten.

## Workstation usage

Use pinned Node24.22.1 on the owner's arm64 Mac, a pristine checkout of merged
main, warm dependency installations matching both lockfiles, and explicit
loopback-only PostgreSQL test settings. The tests create/drop only their own
random disposable databases; never provide a production `DATABASE_URL`.

```sh
PGHOST=127.0.0.1 PGPORT=<local-test-port> PGUSER=postgres PGDATABASE=postgres \
python3 deploy/local_frontend.py --rehearse

# Same checks/build, then immediate standard blue/green promotion:
PGHOST=127.0.0.1 PGPORT=<local-test-port> PGUSER=postgres PGDATABASE=postgres \
python3 deploy/local_frontend.py
```

`--rehearse` validates gates/builds but does not start or replace running apps,
switch routes, log into public admin, or alter member/reader data. `--redeploy`
is a separate explicit owner benchmark flag for rerolling an already-live SHA.
Logs and receipts remain in a private temporary directory or the specified
`--evidence-dir` outside the checked source tree.

Activation uses the ordinary deployment lock, interrupted-activation recovery,
immutable image/source identity, fresh readable backups, exact migration
checksums, original DB/JWT/reader/notification configuration, standby/demo/public
authenticated smokes, immediate main/pause/check revalidation, atomic route,
rollback journal and delayed old-slot retirement. No migration, seed/reset,
permission change, secret rotation or volume deletion is introduced.

The frontend-only path deliberately **preserves** the separate private
`arbor-mvc-current` demo image/configuration/process; its existing health/auth/assets
are still checked. Only the public site is updated. Demo accounts accessed on the
public site receive the new public UI normally. Ordinary full releases still
update both stacks. The journal records this scope so rollback/recovery also
leaves the private demo process alone.

## Rebuild cache (normal Dockerfile)

BuildKit's locked TypeScript graph cache survives a frontend-only source change.
Both projects retain all strict compiler options; only incremental graph storage
moves into the cache mount. Tracked source, node_modules, generated graph files
and the cache directory are not injected from the workstation into the image.
The actual Vite bundle is rebuilt, not reused as an unverified artifact.

The build command refreshes TypeScript input timestamps before compilation so an
older-timestamp checkout cannot silently skip a changed source file. A real-compiler
regression exercises that exact Dockerfile command: warm valid graph, changed
invalid source with an old timestamp (must fail), then corrected old-timestamp
source (must pass). It runs in the frontend CI lane.

On the existing host, isolated changed-frontend image builds measured21.479s
before this cache,20.182s for its first cold fill, then3.945s for a subsequent
changed-frontend rebuild. The timing-only image was never deployed. This Dockerfile
optimization is repository code; it is separate from the currently installed
operator fast path and takes effect after a normal reviewed full release.

## Honest timing

The client reports elapsed time from invocation through **all selected local
checks, source/image preparation, evidence transfer and verified promotion**.
The checks and speculative image build overlap. Dependency installation on a
cold machine is not included in warm-path results. Git push/merge transit before
invocation is not included; report it separately when timing actual pushes.
`--rehearse` is a rehearsal, not evidence of a completed production cutover.

The existing `activation-metrics.json` still reports preparation, public cutover
and post-cutover verification separately. Never describe its cached rollout-only
number as end-to-end push/check/build time.
