# Reader rollout and 500-user performance follow-up

## Changes

- Aggregate each member's waiver/certification status once rather than repeatedly
  scanning the materialized status sets for each member. Filters, detail rows,
  summaries and export behavior are unchanged.
- Materialize membership report bucket bounds and converted membership windows
  once. Repeated timezone conversion inside the correlated period scans was a
  separate reporting bottleneck; people, renewals and cancellation semantics stay
  unchanged.
- Optional `ARBOR_DB_POOL_MAX` accepts integers 1–30; unset retains the original
  default of 10. The measured operator setting is 20. Budget connections across
  both overlapping public processes, not just one: 20 + 20 leaves room below the
  existing production PostgreSQL limit of 100. Demo uses a separate database
  container. No database-wide connection limit is raised.
- Fix the Pi installer's systemd `WorkingDirectory` escaping and validate both
  generated units with `systemd-analyze --user verify` before stopping the existing
  reader gateway. Unrecognized operator unit changes still require review.

## Verification

The isolated dataset was restored from a fresh private production backup, then
upgraded locally. No email, Stripe, hardware worker or production user seeding ran.
It contained 21 retained accounts, two synthetic operator fixtures and 500 added
synthetic members. Two pending accounts are intentionally absent from the directory;
all 500 added members appeared across its 11 pages. Existing account rows were
unchanged by the load harness.

With pool size 20 on local Node 24.22.1 / PostgreSQL 16:

- 1,000 mixed requests at concurrency 25: p95 24.17 ms, maximum 38.97 ms.
- 1,000 mixed requests at concurrency 100: p95 73.16 ms, maximum 83.56 ms.
- 500 distinct member profiles at concurrency 50: p95 13.23 ms.
- All 2,500 burst requests returned HTTP 200. Synthetic signed reader decisions
  correctly denied missing waivers; no physical card or successful relay grant
  is implied.
- Individually sampled endpoint p95 values ranged from 1.28 to 5.97 ms for member
  search/detail, compliance, reports, audit, overview, equipment, readiness and NFC.
- Password login p95 remained 209.36 ms. Bcrypt cost 12 is unchanged; passwords,
  credential validation and authorization decisions are not cached or weakened.

Exact old/new outputs matched in 72 compliance filter/export combinations and 27
membership report combinations spanning timezones, periods and DST boundaries.
A permanent integration regression adds 500 memberships and 250 touching renewals
across New York's 25-hour DST day, checking distinct people and expiry counts.

The Pi installer fix was exercised on the actual owner-connected Orange Pi.
Discovery/TLS services run and authenticate to production, retain the old C3
profile, and report the connected USB mini. The classic reader service was not
changed. Location selection/provisioning and a physical card tap remain distinct
acceptance steps, not simulated successes.

These are controlled local timings, not a production network latency or unlimited
concurrency guarantee. Keep the standard CI, migration checks, blue-green health
verification and retained rollback process for rollout.

## Sparse production planning follow-up

The first live verification caught a separate issue absent from the populated
load fixture: reports took about 550 ms with only three stored memberships.
Read-only query profiling showed an estimated cost of 1,764,216 and approximately
515 ms spent in PostgreSQL JIT compilation, rather than executing the report.

Materializing cancellation evidence once avoids the per-estimated-bucket
correlated outbox scan. With JIT still enabled, the candidate membership query
took 1.57 ms versus 643.94 ms for the original on the same live database. Full
report output hashes matched after excluding only the generated-at timestamp.
No global JIT, planner or database settings were changed. A sparse-database
integration test guards the default JIT planning threshold; existing tests cover
confirmed and durable cancellation evidence, distinct people and export results.
All 27 timezone/bucket/DST differential cases still matched exactly.

This read-only operator comparison is not itself a deployed-release claim or a
physical-reader acceptance test. The follow-up must pass the same exact-main CI
and blue-green verification before release.
