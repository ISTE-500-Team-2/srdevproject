# Unified website and reader data: cutover proposal

## Scope and current state

This change prepares a cutover, not a production deployment or automatic merge.
No database, card identity, reader secret, runtime configuration or schema is
changed by these files. The application already passes one PostgreSQL pool to
its website, staff, instructor and device routes. The integration defect is the
RLES gateway's special routing of `arbor-pi-01-test` to the demo app.

The read-only inventory on October 22 found these **separate datasets**, not
replicated copies of production:

- Public website: `arbor_email_dev`, served by `arbor-email-app` (8082).
- Demo/NFC test: `arbor_mvc_dev`, served by `arbor-mvc-current` (8081).
- Legacy shared SQL development: `collaboratory_dev` (tunnel port 15432).
- `collaboratory_staging` and `collaboratory_prod`: empty public-schema scaffolds.

Names do not determine environment purpose. The public database remains the
candidate authoritative dataset for real activity; demo/development remain
isolated. Do not replace the public data with either the legacy development
database or an empty database named `prod`. Do not rename/delete any databases.
Public signups are **not expected** in the legacy SQL development connection.
New local development should use [the isolated launcher](LOCAL-DEVELOPMENT.md).

## What this PR implements

- `deploy/rles-edge.mjs`: manual-install cutover candidate derived from the
  running gateway. Website, device decisions and authenticated gateway health all
  use the same public backend (8082). Removes the reader-ID bypass to 8081;
  keeps peer restrictions, gateway bearer authentication, raw HMAC request bytes,
  forwarding-header sanitization and unavailable-upstream failures. No demo
  fallback. Does not change NFC hardware, HMAC format or application policy.
- `backend/src/scripts/environment-inventory.ts`: read-only consistent snapshot
  of public table counts, columns, constraints, indexes, triggers, RLS policies
  and migration checksums. Requires the expected database name and bounded query
  and lock timeouts. Exports no user/card/payment/waiver rows or credentials.
  Comparison is offline and never authorizes an import, even with equal counts.
  This is not a complete `pg_dump` schema/ACL/function/object-store comparison.
- Real gateway/application/PostgreSQL tests prove a freshly registered and
  confirmed website user is visible to staff, can receive a card and a
  staff-recorded payment/membership, sign waivers, and receive a reservation-linked
  NFC check-in visible in the staff portal. Wrong signatures and card revocation
  deny access. SQL supplies only the active reservation clock fixture.

No automatic installer or deployer references the new gateway file. Merging this
PR alone cannot alter the running edge's reader route. No business logic, database
migrations, role policy or Stripe live-payment enablement is added.

## 1. Capture evidence before selecting records

Use the **existing protected environment** for each application separately; the
tool uses the application's own `DATABASE_URL`/PG parser. Never paste a connection
string or password into a command. From the backend directory after `npm ci`:

```sh
umask 077
npx tsx src/scripts/environment-inventory.ts snapshot --expect-database arbor_email_dev > public.json
# In the separately configured demo context, NOT against the public connection:
npx tsx src/scripts/environment-inventory.ts snapshot --expect-database arbor_mvc_dev > demo.json
# The comparison makes no database connections:
npx tsx src/scripts/environment-inventory.ts compare demo.json public.json > comparison.json
```

Keep these reports in protected operator storage, not Git. Repeat for legacy
development only if records there are proposed for preservation. Read access must
cover all public tables; missing privileges or RLS filtering abort, not produce a
misleading zero. Do not expand runtime privileges just to generate a report.
Compare full schema-only dumps, ACLs, functions, triggers and migration checksums
on restored copies too. The 15-table original design versus expanded app schema
must be reconciled explicitly; do not modify Edwin's design or apply pending
migrations merely to make counts match.

## 2. Back up, restore and review identity mapping

Take fresh full backups of both populated databases, linked object storage and
protected application/reader/gateway configuration. Record checksums, restore
each into isolated unexposed clones, and verify table counts **and linked business
records**, constraints, signed-copy retrieval, logins and runtime-role access.
Existing backup evidence does not replace a fresh pre-cutover restore rehearsal.

Have Matt review a protected mapping manifest before any data write. Each selected
record needs source database/type/ID, verified target identity, dependency mapping,
disposition (keep/import/re-enroll/test-only/conflict), justification and reviewer.
Never publish that manifest's personal data on the PR. Cover:

- Users: verify person/account ownership; email matching is only a candidate,
  never an automatic merge. Preserve public accounts and roles. Do not copy
  sessions, password resets, synthetic demo administrators or permissive overrides.
- Cards: re-enroll through the authenticated public admin API after verifying the
  person. Hashes depend on `ACCESS_CARD_HASH_KEY`; copying hashes across different
  keys silently breaks access. Do not rotate or copy the demo hash key over the
  public key. Reader shared secrets remain protected, separate from card hashing.
- Resources: map building/room/equipment by verified physical identity, not numeric
  ID. Confirm each public reader's `kind`/`resourceId` exists and is correct.
- Memberships, payments, reservations and certification history: preserve foreign
  keys and provider references; never replay a payment/checkout/webhook to migrate
  history or grant access based only on a copied "paid" field.
- Waivers: retain original document wording, version, signature identity/time and
  stored signed copy. Never manufacture missing legacy copies or replace original
  wording with the current document. Keep historical audit provenance; never
  disable append-only protections to insert old events.

There is deliberately no generic merge/import script. Actual unresolved conflicts
must be resolved in the manifest before a narrowly reviewed import is written.
Test-only records can remain solely in demo. The conflicting staff/instructor,
guest and certification-expiry requirements need sponsor clarification; this PR
does not change policy to resolve them.

## 3. Rehearse public reader configuration on isolated copies

Configure the clone with its **own protected** `ACCESS_CARD_HASH_KEY` and
`ACCESS_READERS_JSON`. Use a distinct real-operation reader ID with a separate
secret; reserve `arbor-pi-01-test` for demo acceptance. Inventory the current reader
service's actual config format before preparing any edit; this PR does not assume
the adapter's config is identical to the hardware service. First validate on the
clone, not by enrolling a real member in a demo identity.

Rehearse with the candidate gateway against the cloned public app, with outbound
email disabled and mocked payment transport. Prove:

1. Registration/confirmation and staff visibility refer to the same user.
2. Staff-recorded payment, and separately sandbox Stripe payment/webhook, create
   the correct entitlement and receipt. Failed payment does not grant access.
3. Current waiver version/signed copy, required certification, active reservation
   and correct resource are all enforced. Missing/expired/revoked records deny.
4. A signed physical scan returns the correct identity and writes exactly one
   linked check-in visible in the portal; replay is denied.
5. Card/account revocation and API/network outage deny access without demo fallback.
6. Demo remains functional and isolated; public accounts and historical records
   are unchanged except for the explicitly approved mapped records.

Automated tests in this PR cover routing and a staff-recorded-payment/room-access
path. Existing resource/training/payment suites cover additional policies. This
is **not** a claim that paid day-pass browser checkout, all 129 requirements, real
email delivery, payment-provider integration or physical hardware were reaccepted.

## 4. Controlled installation and rollback (not executed by this PR)

After Matt's review and owner approval of the concrete mappings/configuration:

1. Record exact app/edge/reader revisions and checksums. Resolve the separately
   pending audit/resource migrations and minimal runtime grants under their own
   reviewed approval; this PR does not apply them. Pause the automatic app
   deployer during the maintenance window using its documented pause control.
2. Back up again, briefly quiesce writes and take final snapshots; recheck mapping
   conflicts. Apply only separately reviewed mapped writes, if any. Preserve all
   source databases and objects. Record every changed row and its rollback action.
3. Verify the public app's device configuration and correct resource mapping.
   Install the reviewed gateway candidate at the existing edge mount using the
   existing service definition/environment. Keep a checksum-verified copy of the
   old gateway. No new listeners or Docker-network/SSH grants are needed.
4. Coordinate the reader's reviewed ID/secret/endpoint configuration change with
   that route change. Do not leave the existing test reader expecting demo while
   the public edge points to public. Verify a physical permitted and denied scan,
   linked public check-in, revocation, website login, signed-copy retrieval and
   gateway health. Preserve the existing LED-only prototype; no machine actuation.
5. On any failure, disable the reader's active session and restore the exact prior
   edge, protected app config and reader config together. Verify demo and public
   login health. Do not drop data or restore a stale database over newer activity;
   use the reviewed row-level rollback/reconciliation plan for any imports.
   Resume app deployment only after the application/database versions agree.

Handoff retains one authoritative dataset per environment, with portable Linux
configuration. RLES is not the sponsor's permanent production destination.

## Requirements anchor

Source: [requirements list](https://docs.google.com/spreadsheets/d/184RKIAmphd5ZCQp4SQwmov3Lg6HmdlOM2bpWs5Ei1vQ/edit)
and [architecture](https://docs.google.com/document/d/1CeyE5pD_pmIZr6uXAO0zj9VhvVfYmsID3w42Trb4ly4/edit).
Routing/shared identity supports EXT-001, FR-036/037/038 and NFR-001; linked
reservation enforcement BR-001/005; signed-copy preservation B-016, FR-040/044;
history/audit FR-061 and NFR-007/012. Manual recorded payments remain FR-054/055;
they do not initiate a charge. This change claims no blanket completion status.
