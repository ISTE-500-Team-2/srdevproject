# MVC verification — September 8, 2026

## Passed

- Backend TypeScript build and **4 unit tests**.
- Frontend TypeScript/Vite production build and **6 unit tests** (including the 4 inherited mock-data tests).
- **7 integration tests against real PostgreSQL 16.14**: sessions/account persistence, protected writes, reservation reload/ownership, concurrent conflicts and adjacent bookings, eligibility/waivers/check-in, day-pass date restrictions, and idempotent migration/setup.
- **1 full React → Express → PostgreSQL integration flow**: member login, catalog read, reservation creation, complete React unmount/remount with session recovery, saved booking retrieval, cancellation, waiver signing, and persisted check-in. React is exercised with jsdom; API/DB operations are real, not mocked fixtures.
- Docker image builds successfully on Ubuntu-8802 with Node **22.23.2**. Runtime runs as non-root `node`.
- Live isolated-container HTTP smoke check: health, frontend HTML, catalog and reservation creation.
- **Container restart test:** the same session still works and the reservation remains confirmed after restarting the app container. Cancellation and logout succeed afterward.
- All temporary integration-test databases were cleaned up; **0** remain.
- `git diff --check` passes. Dependency manifests and lockfiles match.

Total automated suite count: **18 passing tests**, plus container HTTP/restart verification.

## Scope and limits

The demo is on the separate `arbor-mvc` Compose project and `arbor_mvc_dev` database. The old migrated dev/staging/production services have not been migrated or replaced. No public app deployment or production-data conversion is claimed.

The demo contains synthetic accounts, equipment/rates, membership entitlement and a sample policy. Writes are real database writes to that isolated data set. Classes and admin reporting remain explicitly labeled design previews. Payments, studio leasing, staff management, physical readers and email/reset flows remain outstanding. Figma MCP is not connected.

No fresh browser screenshot/visual verification was performed; the rendered component interaction test and HTTP/static-asset checks are distinct from browser visual QA. A manual presentation-device check is still appropriate before the review.

The `mvc-verify.yml` CI workflow is included but has not run on GitHub; the reported checks above ran locally against the isolated VM PostgreSQL instance.
