# Early building check-in

Started from freshly pulled `origin/main` at `bdf44c1` on branch `codex/early-building-check-in`.

## Behavior

Building entry now depends on facility eligibility, independently of reservation times or whether a member has a reservation. It still checks active account/access status, current membership or day pass, current required facility policy signatures, available building, and applicable minor supervision. An approved physical NFC tap records a facility visit and a building-only check-in, with null room, equipment, and reservation IDs. Renewal requests recheck eligibility without duplicating check-ins. Reader approvals retain the existing five-second maximum lease and earlier eligibility expiry limits.

Room and equipment grants still require the member's own confirmed reservation for that specific resource, with `start <= now < end`. Equipment still checks certification and applicable equipment waivers. Invalid resource-reader configuration cannot fall back to a building grant. Facility entry does not activate an equipment reservation or change its status.

The website reports facility eligibility before reservations begin and explains that reserved resources must wait. Members still tap at the door or ask staff to record their arrival; web eligibility alone does not establish presence.

## Verification

Docker Node 24.22.1, real HTTP application tests, and disposable PostgreSQL databases:

- Backend TypeScript build and 62 unit tests passed.
- Frontend TypeScript/Vite production build and 339 unit tests passed.
- Full backend integration suite: 338 tests passed.
- Full frontend browser integration rerun: 36 tests passed across 14 files.
- Final source targeted integration run: 33 tests passed, including the added early minor entry test and invalid reader configuration checks.
- Reader Python adapter/setup suite: 26 tests passed in a temporary virtual environment with pyserial.

New regression coverage verifies early building NFC approval, visit/check-in fields, no duplicate check-in on renewal, denied early equipment/room taps, denied early staff equipment check-in, reservation boundaries one millisecond before start, exactly at start, one millisecond before end, and exactly at end, building availability, restricted accounts, missing facility waivers, and sponsor-dependent early minor entry. Existing integration coverage checks equipment certification/waivers, entitlement expiry, card revocation, authenticated reader requests, and staff preview parity.

The first full frontend integration run exposed an existing cancellation/catalog reload race in its test. The test now waits for the equipment catalog before clicking its next booking.

Physical reader hardware and its actual green LED were not available for verification. Approved building decisions use the existing reader transport's `allowed=true` → `approved` mapping.

The existing local Docker preview was rebuilt with the changes; its health endpoint reports a connected database. No remote deployment was performed.


## Revalidation against updated main

Integrated `origin/main` at `cfc774b` (equipment Stripe checkout, 30-minute paid booking lead time, and waiver validity through reservation end) by fast-forwarding the working branch and reapplying the early check-in changes. Both the shared access service and browser reservation test merged cleanly; the new payment and waiver requirements remain intact.

Added a regression test using the real reservation/payment services and simulated Stripe responses: an eligible member gets a building grant while checkout is pending, a pending hold never grants equipment access even at its scheduled start, payment confirms the reservation, confirmed payment still cannot grant early equipment access, and equipment becomes eligible exactly at the paid reservation's start. No real provider calls or charges are made.

The targeted equipment payments, equipment waivers, and resource-access integration run passed all 24 tests, including the new checkout/building-entry regression.

Full verification against the integrated main passed: backend build and 62 unit tests, frontend production build and 347 unit tests, 358 backend integration tests, and 37 frontend browser integration tests across 15 files. The additional payment-specific regression passed in the separate 24-test targeted run. The local Docker preview was rebuilt against the integrated main and its health endpoint reports a connected database.

## Booking dialog visual correction

The shared hourly-price component used an unstyled definition list in a generic panel and retained obsolete front-desk payment instructions alongside the new checkout instructions. Added scoped price-summary styling with padding and aligned amounts, removed contradictory/duplicated payment messages, and moved the time hint across both controls. Verified the real local dialog visually, checked 390px layout without horizontal overflow, and saved `booking-price-desktop.png`. Frontend build and all 347 unit tests passed, plus all 6 booking/waiver/staff integration tests across 4 files. Local Docker preview rebuilt successfully.

## Review correction: preserve the actual check-in building

Review reproduced a staff arrival in building 2 being silently transferred to building 1: the staff screen submitted an empty target and the service defaulted it to 1. This also ended supervised minors' visits through the existing adult-transfer behavior.

Unscoped facility access now preserves a current same-day visit. Without a current visit, a single configured building can be selected automatically; multiple buildings require a choice instead of assuming building 1. The overview accepts `buildingId`, returns the building choices and resolved target, and uses the same target for eligibility. Staff see the building and send its ID explicitly when recording arrival. Members can preview another building's eligibility, but still cannot establish presence from the website. Resource reservations, signed reader decisions, and lease checks are unchanged.

Changing the selected building disables staff check-in until its eligibility response arrives. Overview responses carry the authenticated subject ID, and switching accounts invalidates the request and selection so another member's eligibility cannot be reused.

Regression coverage includes ambiguous first arrival, explicit building choice, malformed query IDs, repeating second-building arrival while building 1 is unavailable, preserving an adult's supervised minors and their reader renewals, stale-response/account-switch guards, and an actual React/HTTP/PostgreSQL staff workflow for first arrival, repeated arrival, and deliberate transfer. The original review reproduction now retains building 2.

Local Node 24.22.1/PostgreSQL 16 verification: both builds, 62 backend and 350 frontend unit tests passed. All 362 backend integration tests passed with four-worker concurrency and all 38 frontend integration tests passed. After the final account-response guard, both builds/unit suites and 64 focused backend plus 3 frontend HTTP/PostgreSQL tests passed again. The initial simultaneous high-concurrency backend run had three unrelated HTTP-test failures; the relevant tests also ran on the unchanged PR head, and the bounded full rerun passed without changing those tests. No production database, reader hardware, schema, or deployment was changed.
