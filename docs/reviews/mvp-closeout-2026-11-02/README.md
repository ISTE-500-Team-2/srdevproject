# MVP closeout: catalog, supervised minors, classes and member check-in

Based on merged PR #86 (`c63bfd0`). Existing paper/espresso/bronze components are reused; this is not an authentication or site redesign.

## Scope and preserved behavior

- Retire obsolete equipment from the member catalog without deleting its equipment, booking or payment records. Migration `033_retire_generic_cnc.sql` retires exact `Welding Station` and, only when all three named replacements exist, generic `CNC Machine` entries; retired machines are hidden from members and cannot be booked by id. The preview-first script applies the same rule idempotently. Custom equipment names and existing certification links are preserved.
- Configure CNC/metal-lathe/wood-lathe training metadata as 60 minutes/$20 and link named machines that have no certification. Existing certification validity is preserved; new definitions have no guessed renewal period. An authorized instructor still records actual training separately.
- Keep minor registration enabled. A persistent Under 18 badge includes the linked adult. Staff verify adult agreement before linking, with a reason and optimistic revision. Adults can also request a link from their profile with the minor's email and date of birth; the minor accepts or declines from their home page and both sides are emailed (migration `034_minor_sponsor_request.sql`). Self-service only fills an empty sponsor slot; changing an existing sponsor stays with staff. Request attempts are rate-limited in the database (10 per adult per day, 5 misses per adult and email per day, 15 misses per email per 30 days) and store only a hash of the target email. Both people need their own valid membership/day pass and existing required policies. Adult presence must be in the relevant building.
- Record minor bookings against their sponsor. Staff check-in or authenticated NFC establishes a visit. Adult checkout (or authenticated arrival at another building) also ends supervised minor visits; renewal checks deny after checkout. Existing bounded reader leases are unchanged, so a previously issued grant may remain valid for up to its existing five-second lease. This is not a claim of instantaneous physical relay cutoff.
- Preserve non-admin staff restrictions on managing protected staff/admin accounts. All new application tables have change-capture and no-unlogged-truncate guards.
- Add four sponsor-provided creative workshop templates and descriptions, not invented events. New classes and enrollment are capped at 15 (and room capacity). Workshop attendance does not automatically grant equipment certification. Historical larger classes remain readable/cancellable.
- Remove the member Slide-to-check-in control. Viewing an eligible home screen must not create physical attendance; NFC/staff check-in APIs remain available.
- Add mobile spacing and dark-mode support to existing email templates: classes tagged at render time are recolored for `prefers-color-scheme` (Apple Mail) and `[data-ogsc]`/`[data-ogsb]` (Outlook), and the logo ships on a light plate so it stays legible under Gmail's forced inversion. The auto-renew opt-out email now says auto-renew is off. Security-token fragments, content escaping and cancellation/payment lifecycle remain unchanged.

## Release/configuration sequence

This branch does **not** apply schemas/catalog changes to production. Automatic release must continue refusing an unapplied migration.

1. Review the final commit and CI, back up production, and restore/rehearse that backup in isolation. Do not run demo initialization against production.
2. Apply additive `031_minor_supervision.sql`, `032_class_catalog.sql`, `033_retire_generic_cnc.sql` and `034_minor_sponsor_request.sql` through the existing owner migration runner, preserving checksums, on **both** the public and demo databases (auto-release refuses to roll out until every migration is present). Grant only the current runtime role's necessary DML on the nine new application tables (`app_minor_sponsor`, `app_facility_visit`, `app_minor_booking`, `app_minor_studio_booking`, `app_class_catalog`, `app_training_requirement`, `app_equipment_retirement`, `app_minor_sponsor_request`, `app_minor_sponsor_attempt`) and USAGE/SELECT on the four new identity sequences: `app_facility_visit_id_seq`, `app_class_catalog_id_seq`, `app_minor_sponsor_request_id_seq` and `app_minor_sponsor_attempt_id_seq`. Do not grant schema ownership, ledger access or broader existing-table privileges.
3. With the owner/configuration connection loaded securely, run `backend/node_modules/.bin/tsx backend/src/scripts/configure-mvp-catalog.ts` for a dry-run plan. Inspect exact equipment IDs and the presence of the named CNC replacements (after migration 033 the retirement list should already be empty; the script still links training definitions). After approval, rerun with `--apply --actor-id <active-admin-id>`. Repeating the operation is idempotent; no history is deleted.
4. Release the reviewed application through the existing immutable-image workflow and verify the live SHA. Confirm catalog visibility, existing reservation/payment records, admin/member navigation and cancellation receipts.
5. Staff choose approved training validity in the existing training configuration UI before granting the newly defined certifications. Add real workshop dates, instructors, rooms and approved pricing when supplied. No prices are invented for the creative workshops; no class-payment collection is added by this change.
6. Link a real consenting adult/minor pair and test the physical NFC/checkout behavior with Max present. No card tap or relay actuation was performed for this implementation.

For rollback, restore the previous application image while retaining additive tables and existing data; do not drop attendance/audit records. Reverse catalog availability/links only by reviewed, audited configuration if required. Never reseed or delete production records to roll back.

## Verification

Use Node 24.22.1 and an explicitly configured isolated PostgreSQL database:

- `npm run check --prefix backend`
- `backend/node_modules/.bin/tsx --test --test-concurrency=1 backend/test/integration/*.test.ts`
- `npm run check --prefix frontend`
- `npm run test:integration --prefix frontend`

New integration coverage includes sponsor consent/age/access/CSRF/revision, same-building class enrollment, sponsor-booking linkage, protected targets, minor-only checkout renewal, adult building transfer, simultaneous adult checkout/minor arrival, capacity races, preview/apply idempotence and preserved audit/history. Existing suites cover billing, cancellation emails, studio conflicts/refunds, registration, and reader authorization. Browser checks use only fictional local accounts and rendered email HTML; they do not establish delivery or rendering in every real mail client.

Production cancellation evidence already included two provider-accepted messages, not confirmed inbox delivery. An uncertain historical waiver send must not be blindly resent.
