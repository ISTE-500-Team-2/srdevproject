# Team ARBOR Senior Development Project

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

The CI workflow validates the scripts against PostgreSQL 16 and checks for 15 tables, 17 foreign keys, and the expected synthetic seed counts.
