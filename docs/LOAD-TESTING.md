# Load testing and performance acceptance

`testingBranch` adds repeatable HTTP load tests for NFR-005, NFR-006,
NFR-008, NFR-009 and NFR-019. The critical peak-hour check-in case is TCR-034.
The default acceptance target is 500 synthetic members with 25, 50 and 100
concurrent requests. These targets were confirmed for this task.

## Run the tests

Use Node 24 and PostgreSQL 16, with backend dependencies installed. The PostgreSQL
role must be able to create and drop databases. The runner creates a fresh
`arbor_load_<random>_mvc_test` database, applies migrations, seeds synthetic
fixtures, starts the actual Express app on an ephemeral loopback port, and drops
that database on completion, including ordinary failures. It does not target an
existing app, require a hardware reader, or run email/payment workers.

Set an explicit `PGHOST`, `PGPORT` and `PGUSER` for an isolated local/test server.
Unset `DATABASE_URL` and `PGSERVICE`; `NODE_ENV=production` is refused. Existing
databases and member accounts are not populated or modified. If a process is
forcibly killed, inspect for its disposable database before manually removing it.

PowerShell, using the repository's local Docker PostgreSQL service:

```powershell
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '25432'
$env:PGUSER = 'arbor_mvc'
$env:PGDATABASE = 'postgres'
npm run test:load --prefix backend
```

POSIX shell, for an isolated PostgreSQL service:

```sh
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=postgres \
  npm run test:load --prefix backend
```

Profiles and overrides:

```sh
# Fast CI check: 50 members, concurrency 10/25, 100 requests per burst, 10-second sustained run.
npm run test:load --prefix backend -- --profile smoke

# Default acceptance: 500 members, concurrency 25/50/100, 500 requests per burst, 60-second sustained run.
npm run test:load --prefix backend -- --profile acceptance

# One-hour reliability run; use 28800 seconds locally to cover an eight-hour scheduled access period.
npm run test:load --prefix backend -- --profile soak --duration 3600

# Sustained traffic at the peak level as well as peak bursts.
npm run test:load --prefix backend -- --concurrency 100 --duration 300 --label peak-soak
```

Additional options: `--users`, `--requests`, `--output`, `--label`. Users and
requests per stage must cover the largest concurrency. Durations accept 1–86400
seconds. `ARBOR_DB_POOL_MAX` accepts 1–30; tests default to the application's
existing 10 connections. An increased connection budget is not required by the
optimization. Default reports go to `.local/load-results/latest.json` at the
repository root when using the npm command above. Failures exit nonzero and still
write results. Reports omit card identifiers, reader keys and bearer tokens.

## Workloads and pass criteria

The runner warms the app, records an equal-concurrency baseline, executes a
same-entrance burst and mixed traffic at each concurrency, then measures sustained
traffic in ten-second windows and an equal-concurrency recovery stage. Latencies
include HTTP connection/pool queueing and response-body consumption.

| Requirement | Workload and enforced threshold |
| --- | --- |
| NFR-005 | HMAC-authenticated `POST /api/devices/decision`; every measured response must complete in **less than 2000 ms**. Eligible members must receive a current grant and a persisted decision ID. |
| NFR-008 | Authenticated `GET /api/me/waivers`; less than **6000 ms**, with the expected current signature status. Equipment reader requests also enforce required waivers. |
| NFR-009 | Authenticated `GET /api/me/certifications`; less than **6000 ms**, with the expected machine-training status. Equipment reader requests enforce the certification. |
| NFR-019 / TCR-034 | Bursts of 25/50/100 concurrent HTTP requests across a 500-member fixture, including contention on one entrance reader. Any incorrect response, false grant, verification timeout or latency violation fails the run. |
| NFR-006 | Continuous mixed traffic plus database-backed health checks for the configured duration. Future and ended reservation windows are denied in integration tests. First/last sustained windows and baseline/recovery latency are compared. |

Ten percent of fixtures lack facility signatures; another ten percent lack
equipment training. Their correct denials count as successful validation, while a
fast timeout or an incorrect denial of an eligible member counts as a failure.
The final database check requires one check-in for each allowed decision and zero
grants to the ineligible cohorts.

Stability requires recovery and final-window p95 no greater than the larger of
twice the corresponding initial p95 or initial p95 + 100 ms. Final sustained
throughput must remain at least 80% of the first window. These explicit local
regression tolerances supplement the strict per-request NFR deadlines; they do
not redefine the NFRs as percentile-only targets. A tiny final partial window is
excluded from the throughput comparison. Reports contain p50/p95/p99/max,
throughput, errors, timeout counts, SLO violations, event/check-in counts, pool
queue peak, process RSS and event-loop delay.

The load generator prepares normal database-backed sessions outside measurement
and renews synthetic session fixtures between windows every ten minutes for long
soaks. Measured API calls still authenticate and authorize normally. Password
login, browser rendering and the refresh-token HTTP flow are separate tests.

## Optimization and safety regressions

Reader decisions previously held an exclusive reader-row lock for the full
eligibility transaction and updated `last_seen_at` on every request. That
serialized otherwise independent members at a busy entrance and caused legitimate
verification timeouts.

Ordinary taps now share the reader metadata lock. Reader disable, enrollment and
credential changes retain exclusive locks; heartbeats retain their original
metadata write. The staff reader list and reader-health notices also recognize
authenticated tap and renewal events as presence. Additive migration
`038_reader_presence.sql` indexes this latest-event lookup without removing the
tap-only indexes used for card history. Shared
locks can race duplicate event IDs, so the unique event insertion explicitly
returns a replay error to the loser and rolls back its transaction.

No eligibility results are cached, no authentication checks are removed, and the
1.8-second verification deadline and five-second lease cap remain. Deterministic
integration regressions cover shared-reader concurrency, simultaneous replay,
disable ordering, heartbeat, legacy tap-only and renewal-only presence, outage recovery,
revocation during bursts, and scheduled reservation windows. Existing suites
cover enrollment capture, guided setup, equipment maintenance, minors, and lease
expiry boundaries.

## CI and operational use

The backend lane of the required MVC verification workflow runs the smoke load
profile after its integration tests and uploads JSON diagnostics even on failure.
Its failure prevents the aggregate `verify` check from succeeding. The manual
**Load and sustained access testing** workflow runs the full 500-member profile
or a soak on a fresh PostgreSQL service, with a 1–3600 second sustained duration,
and retains reports for 30 days.

For scheduled-access acceptance, run the soak for the actual scheduled period on
representative hardware and a dedicated test database. Keep the same concurrency
and connection budget when comparing revisions. A local loopback run establishes
software behavior and a reproducible capacity baseline; it does not establish
physical reader latency, production network latency, all-day uptime or unlimited
capacity. Opening hours are not invented or changed by these tests.
