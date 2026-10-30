-- Email is the sole account login. Dropping the column also removes its format
-- constraint and unique index; account IDs and all related records stay intact.
-- app_user_email_case_insensitive (001_mvc.sql) continues enforcing one account
-- per email, including addresses that differ only by capitalization.
ALTER TABLE "user" DROP COLUMN username;
