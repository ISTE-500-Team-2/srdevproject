# Team ARBOR Senior Development Project

## MVC application

The integration branch connects React views to Express controllers/services and PostgreSQL models, including staff-managed membership/day-pass issuance, facility access, payment records and policy versions.

**Team starting point: [Detailed handoff and walkthrough](docs/TEAM-HANDOFF.md).** Also see the [implementation log](docs/IMPLEMENTATION-LOG.md), [requirements/evidence matrix](docs/REQUIREMENTS-TRACEABILITY.md), [primary verification results](docs/PRIMARY-VERIFICATION.md), and [MVC architecture](docs/MVC.md).

Quick start: `docker compose -f compose.mvc.yml up --build -d`, then open http://localhost:8081. This is an isolated development demo, not the existing team database.

## Database scripts

The PostgreSQL 16 scripts are under `ddl/`:

- `collaboratory-create.sql` recreates a local database named `collaboratoryarbor`.
- `collaboratory-db-create.sql` recreates the 15 application tables.
- `collaboratory-insert.sql` loads synthetic development data.

For a disposable local database only:

```bash
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f ddl/collaboratory-create.sql
psql -v ON_ERROR_STOP=1 -U postgres -d collaboratoryarbor -f ddl/collaboratory-db-create.sql
psql -v ON_ERROR_STOP=1 -U postgres -d collaboratoryarbor -f ddl/collaboratory-insert.sql
```

Both creation scripts are destructive. Do not run them over staging, production, or a development database containing work that has not been backed up.

The CI workflow validates the scripts against PostgreSQL 16 and checks for 15 tables, 18 foreign keys, and the expected synthetic seed counts.
