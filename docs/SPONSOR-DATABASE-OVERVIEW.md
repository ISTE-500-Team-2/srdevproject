# ARBOR Database Overview

**Prepared for:** The Collaboratory  
**Prepared by:** Team ARBOR · RIT Senior Development Project  
**Date:** November 18, 2026  
**Status:** Sponsor review draft

## 1. Purpose and business value

ARBOR's database provides the shared record system behind The Collaboratory's member website and staff workspace. It connects member accounts, memberships, payments, reservations, training, signed waivers, and access activity so staff can manage daily operations using related information in one application.

For example, a member's equipment reservation is connected to their account and the selected machine. The application checks the member's applicable membership or pass, required waiver, training, account restrictions, and reservation conditions before allowing the relevant booking or access action. These decisions use database records rather than relying on information entered in the browser alone.

### What the database contributes

- **Consistent member records:** Staff can connect a person's membership, booking, payment, and compliance history through a common account.
- **Safer scheduling:** Database rules prevent overlapping active reservations for the same equipment or room, including requests submitted at the same time.
- **Traceable decisions:** Staff changes and access activity create records that support follow-up, reporting, and review.
- **Continuity:** Persistent storage and documented backup and recovery procedures support operation beyond the student project.

### How it fits into ARBOR

**Member or staff browser → ARBOR application → PostgreSQL database**

Authenticated reader requests also reach the application, which evaluates the relevant database records and records access activity. Within one configured application environment, website and reader routes use the same database connection pool. Physical reader operation requires separate site acceptance.

The project uses **PostgreSQL 16**, a relational database that stores linked records in tables. The backend manages database access, permissions, and business rules. The sponsor hosting template keeps the database on a private container network and stores its data in a persistent Docker volume. Browsers communicate with the application through HTTPS. [1, 2]

<!-- pagebreak -->

## 2. Information stored and how it connects

The original schema defines the core business records. Versioned migrations extend that foundation for the application's later workflows. Reviewing the original creation script alone does not describe the complete current design. [3, 4]

| Information area | Representative tables | Purpose for The Collaboratory |
| --- | --- | --- |
| Member accounts and permissions | `user`, `role`, `user_role`, `permission`, `role_permission` | Connect identity and account status with the actions a person may perform. |
| Memberships and day passes | `membership_tiers`, `user_membership`, `day_pass` | Define offers and record the access periods issued to each member. |
| Payments and billing | `payment`, `app_membership_billing`, `app_membership_invoice` | Retain amounts, statuses, staff or provider references, and links to memberships or billing periods. |
| Facilities and scheduling | `building`, `room`, `equipment`, `reservation`, `app_studio_rental` | Identify resources and connect members to equipment, room, and studio bookings. |
| Waivers and signed copies | `waiver`, `user_waiver`, `app_signed_waiver_copy` | Preserve policy versions, signature records, and available signed-document copies. |
| Certifications and training | `certifications`, `user_certifications`, `app_training_class`, `app_training_enrollment` | Record requirements, approvals, renewal dates, scheduled classes, and enrollment outcomes. |
| Visits and reader activity | `check_in`, `app_facility_visit`, `app_access_reader`, `app_device_access_event` | Support check-in history, reader configuration, and access-decision review. |
| Accountability and communications | `app_staff_audit`, `app_notification_outbox`, `app_migration` | Track changes, queued notifications, and the schema updates applied to an installation. |

### Main relationships

One member can have multiple memberships, payments, reservations, signatures, and check-ins. A reservation links a member to an equipment item or room. A signed-waiver record links the member to a particular policy version. A certification assignment links the member to a training requirement; classes and enrollment records support the training workflow.

Shared definitions, such as membership plans and certification types, are stored separately from individual member assignments. This reduces repeated data and supports consistent updates. Issued plans also retain snapshots so later pricing changes do not silently rewrite the terms recorded for an earlier issuance. Selected snapshots and document payloads use PostgreSQL's JSONB format alongside the relational tables. [3, 4]

Staff reports use these linked records to review memberships, payments, usage, and missing or expiring waivers and certifications. Reports reflect the data and filters available in the application; they depend on staff keeping source records accurate.

<!-- pagebreak -->

## 3. Reliability, security, and accountability

### Preventing inconsistent records

**Linked-record checks.** Primary keys identify records, and foreign keys connect them to valid related records. Unique constraints prevent duplicates where required, including case-insensitive account email addresses and repeated assignments of the same role to the same user.

**Reservation protection.** PostgreSQL exclusion constraints reject overlapping pending or confirmed reservations for the same equipment or room. Valid-time checks reject an end time that is not after the start time. These protections apply at the database level, including when two booking requests arrive together.

**Complete transactions.** Related writes commit together or roll back on failure. For example, membership issuance can save its entitlement, payment record, and audit information as one operation, avoiding a partially completed result.

**Protection against retries and conflicting edits.** Request identifiers and stored payment-provider event identifiers help prevent duplicate processing. Revision fields let the application detect an outdated staff edit instead of silently overwriting a newer change. These controls apply to the workflows that implement them. [4, 5]

### Protecting access and sensitive information

The application checks authenticated identity, permissions, and record ownership. Members receive access to their own permitted records; staff functions require the applicable privileges. Authorization reloads role assignments from the database, so a role change does not depend solely on older sign-in claims. New account passwords are stored as bcrypt hashes. Queries use bound parameters in the reviewed database workflows. [5, 6]

The sponsor hosting template does not publish the database port to the internet. Database and application secrets are supplied through protected configuration files. Backups contain sensitive member information and require restricted storage and access. Hosting configuration, backup encryption, and operating procedures must be verified on the sponsor's installation. [2]

### Preserving a useful history

Application audit entries record business actions, and database triggers capture change metadata on covered tables without copying credentials or full row payloads into those automatic entries. Audit-table triggers reject ordinary updates, deletions, and truncation. These controls support accountability; they do not prevent a privileged database operator from changing the database's protections.

Waiver versions and member signatures are retained separately. A dedicated signed-copy table preserves available signing-time document payloads independently of notification cleanup. Earlier signatures without a stored copy require individual review; the existence of a signature row does not establish that its original document can be reconstructed. [4]

<!-- pagebreak -->

## 4. Installation, maintenance, and data preservation

### Controlled schema changes

Schema changes are delivered through versioned SQL migration files. The migration runner applies pending files in filename order, records a SHA-256 checksum for each file, and rejects changes to an already applied migration. A database lock prevents simultaneous migration runs, and the migration work runs in a transaction. This provides a repeatable record of an installation's schema history. [5]

The legacy creation scripts include destructive statements, and the insert script loads synthetic data. Existing installations must follow the documented migration or recovery path. A new sponsor installation starts without sample member and business records. [1, 2, 3]

### Backups and recovery

The sponsor operations helper creates a PostgreSQL custom-format archive and checks that PostgreSQL can read its archive index. A persistent database volume protects records across ordinary container replacement, but it does not replace a backup.

The handoff procedure calls for private off-server backup copies, protected configuration and secret-file recovery copies, and a restore rehearsal into a separate empty installation. After restoration, the operator should verify linked member records, memberships, payment history, signatures and signed-copy retrieval, permissions, and migration history.

The supplied backup command is manual. Automated scheduling, monitoring, retention, and recovery targets must be assigned and verified before routine operation. The sponsor should agree how much recent data may be lost and how quickly service must be restored; this document does not claim those targets have been established. [2]

### Keeping environments separate

Local demos, shared school deployments, and the eventual sponsor installation are separate environments. Earlier project inventories identified different datasets behind the public website, NFC demo, and legacy SQL connection. Database names alone do not establish which records are authoritative.

Before any transfer, the team must identify the intended source, inventory records and configuration, rehearse recovery, and review identity and resource mappings. Accounts, access-card identities, payment references, waiver versions, and audit provenance need particular attention. The repository's cutover proposal does not automatically combine datasets or establish that a cutover occurred. [7]

### Ongoing responsibilities

The sponsor should designate a technical operator to maintain backups, review database and application health, monitor storage growth, apply reviewed updates, and document recovery rehearsals. Authorized studio staff should maintain plans, permissions, training approvals, equipment availability, and policies through the application's supported workflows. [2]

<!-- pagebreak -->

## 5. Verification and sponsor handoff decisions

### What the project evidence establishes

Recorded September 8 verification covers transactional issuance, duplicate-request handling, stale-edit rejection, concurrent booking protection, policy-version history, migration reruns, and preservation of records after restart. Recorded October 16 hosting checks include a local archive restore into a separate database with migration history and bootstrap audit preserved. These are dated results for their respective project versions. [8, 9]

The November 11 load-testing report records a controlled software run using 500 synthetic members and 45,414 requests, with zero recorded errors, incorrect access grants, verification timeouts, or deadline violations. It also records 390 backend integration tests passing. The test used local Docker and PostgreSQL 16.14 on a host with 16 logical CPUs; it does not establish equivalent performance on the sponsor's server or physical readers. [10]

This document was prepared from repository code and recorded evidence. Database tests were not rerun, and a live sponsor database was not inspected during its preparation. Current deployment state and acceptance must be verified against the release selected for handoff.

### Decisions and checks before operational acceptance

| Item | Required sponsor or operator outcome |
| --- | --- |
| Records and ownership | Confirm the authoritative source, records to preserve, hosting owner, and authorized operators. |
| Policies and access | Approve membership terms, prices, permissions, waiver wording, and training requirements. The current annual-compliance migration sets waiver and certification validity to 365 days. |
| Recovery | Assign backup ownership, frequency, retention, and recovery targets; demonstrate a restore on the intended hosting setup. |
| Payments | Recognize that staff-recorded payments document external transactions. Stripe is restricted to test mode in this release; database billing records do not establish live card processing. |
| Final acceptance | Verify migrated records, staff/member permissions, reports, and representative workflows. Accept physical reader behavior separately on site. |

### Repository references

Paths below identify the implementation and evidence supporting this overview. Dates identify the recorded checks, not a new certification of the current deployment.

1. `README.md` — project scope, architecture, and release limits.
2. `docs/SPONSOR-HANDOFF.md`; `docs/hosting/compose.yml`; `docs/hosting/arbor.sh` — installation, private networking, backups, and recovery.
3. `ddl/collaboratory-db-create.sql` — base business tables and relationships.
4. `database/migrations/` — application extensions, integrity constraints, auditing, annual validity, and signed copies.
5. `backend/src/db.ts`; `backend/src/scripts/migrate.ts` — transactions and migration control.
6. `docs/rbac.md`; `backend/src/passwords.ts` — permissions and password hashing.
7. `docs/UNIFIED-ENVIRONMENT.md` — environment inventory and proposed cutover safeguards.
8. `docs/PRIMARY-VERIFICATION.md` — September 8, 2026 verification.
9. `docs/hosting/VALIDATION.md` — October 16, 2026 local hosting validation.
10. `docs/reviews/load-testing-2026-11-11/README.md` and `results.json` — November 11, 2026 software acceptance results.
