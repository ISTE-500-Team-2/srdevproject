# Sponsor hosting validation

The sponsor stack is separate from `compose.mvc.yml` and the shared RLES host.
These checks do not authorize or perform a production deployment.

## Local checks performed — October 16, 2026

- Official Docker Compose 2.39.4 parser accepts the template with placeholder settings.
  Parsed paths resolve to the repository build context and intended private key files.
- Configuration assertions: production mode, demo login off, no published database
  or API ports, only 80/443 on the proxy.
- Bash syntax and documentation relative-file links pass.
- Backend TypeScript build passes. A local production-mode process against an
  isolated PostgreSQL 16 database returns healthy database status; demo login fails.
- Empty schema + all 19 versioned migrations apply without demo seeds.
- First-admin SQL refuses an unconfirmed owner; accepts a confirmed active owner;
  creates one audit entry; rejects a repeat attempt without adding another entry.
- Helper refuses a nonempty database before DDL/migration execution in a mocked
  Docker-transport check.
- A real local PostgreSQL custom archive was restored into a separate new database;
  migration history and bootstrap audit survived.
- README screenshots were visually inspected: actual local application, synthetic
  demo records. Printable guide pages and embedded images were inspected.

## Container rehearsal

`.github/workflows/sponsor-hosting.yml` runs `verify-ci.sh` on a disposable Linux
runner, building the actual image and checking secret-file permissions, fresh
initialization, production health, demo-login refusal, bootstrap guards, backup
and restore. Inspect the PR’s **Verify sponsor hosting template** result; the
existence of this workflow is not a claim that its latest run passed.

The CI script refuses ordinary local invocation. It is not a sponsor setup command.
The database password is read by a root entrypoint wrapper before PostgreSQL drops
to its own UID; the application separately reads the UID-1000-owned mounted file.
The CI runner starts only the database and application, not the public HTTPS proxy.

## Still required before production acceptance

A sponsor-owned VM rehearsal, real domain/DNS and HTTPS issuance/renewal, Brevo
confirmation delivery, reviewed real-data recovery, business-policy acceptance,
ongoing off-server backups and monitoring, load/capacity validation, and separate
hardware acceptance. Live Stripe payments are outside this release’s supported
configuration. The guide has not been user-tested with Steph.
