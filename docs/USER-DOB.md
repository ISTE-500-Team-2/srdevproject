# Registration date of birth

Matt's registration acceptance criteria require date of birth. The database
contract is `public."user".dob`, PostgreSQL `DATE` (not a timestamp).

- Send/store calendar dates in `YYYY-MM-DD` format without timezone conversion.
- The column is nullable for existing users whose DOB is unknown. No birthdays
  are fabricated or backfilled, and legacy inserts remain compatible.
- Matt's registration endpoint should validate and require DOB for new signups.
  This schema change does not implement or replace his endpoint.
- No minimum-age rule is introduced by this migration.

Fresh databases receive the field from `ddl/collaboratory-db-create.sql`.
Existing databases receive `database/migrations/005_user_dob.sql`; never rerun
the destructive legacy create scripts on an existing database.

The additive SQL can be applied by itself to the shared legacy development
schema. It is repeatable, and the MVC migration runner can safely apply it later.
Migration number 004 is reserved by the open authentication PR.
