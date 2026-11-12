# Load testing acceptance — November 11, 2026

Implemented on `testingBranch`, based on main `3d922855`. The harness, pass
criteria, isolation rules and commands are documented in
[LOAD-TESTING.md](../../LOAD-TESTING.md). [results.json](results.json) contains
the measured stage summaries and SHA-256 hashes of the optimized production files.

The baseline exposed serialization of same-reader check-ins: 33 verification
timeouts across its stages, including 8 in the 100-concurrent-request entrance
burst. Shared reader metadata locks eliminated those timeouts while retaining
exclusive reader edits and enrollment locks. Duplicate event insertion remains
transactional and explicitly rejects a concurrent replay.

## Comparable entrance bursts

Each row represents 500 signed HTTP decisions from the same 500-member dataset.

| Concurrent requests | Baseline p95 | Optimized p95 | Baseline timeouts | Optimized timeouts |
| --- | ---: | ---: | ---: | ---: |
| 25 | 309.69 ms | 91.03 ms | 5 | 0 |
| 50 | 503.06 ms | 108.04 ms | 5 | 0 |
| 100 | 881.58 ms | 243.21 ms | 8 | 0 |

The final optimized acceptance run completed **45,414 requests**, including 60
seconds of sustained mixed traffic, with zero errors, incorrect grants,
verification timeouts or deadline violations. The baseline used the same burst
sizes and a shorter ten-second sustained segment; total request counts are not a
direct throughput comparison between those two runs.

| Workload | Slowest optimized response | Required upper bound |
| --- | ---: | ---: |
| Access decision | 257.91 ms | Less than 2000 ms |
| Waiver status | 266.51 ms | Less than 6000 ms |
| Training status | 269.72 ms | Less than 6000 ms |
| Database-backed health | 86.24 ms | 2000 ms test threshold |

Sustained first/last-window p95 was 54.31/50.05 ms; throughput was 674.21/716.65
requests per second. Equal-concurrency entrance baseline/recovery p95 was
105.03/88.63 ms. All 10,830 allowed decisions had matching check-ins, and the
database contained zero grants to the ineligible fixture cohorts.

## Verification and limits

- Backend TypeScript build and strict type checking of the load runner passed.
- All 68 backend unit tests and all 390 backend integration tests passed.
- CI smoke load profile and the full 500-member acceptance profile passed.
- The existing required-CI-gate regression passed; both workflow YAML files parsed.
- `git diff --check` passed.

Measurements used local Docker, Node 24.22.1, PostgreSQL 16.14, a 16-logical-CPU
host and the unchanged default application pool of ten connections. The HTTP
generator and Express app shared a process and used loopback networking. No
production member data, external payment/email workers or physical relays were
used. Migration `038_reader_presence.sql` adds the all-event presence index.

This is a controlled software acceptance result. A full scheduled-access-period
soak on representative deployment hardware and physical-reader/network timing
remain operational acceptance steps; a 60-second run does not establish all-day
uptime. Re-run the documented soak for the actual scheduled period before making
that claim.
