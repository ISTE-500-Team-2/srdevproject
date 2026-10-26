-- Replace the legacy purchase catalog while retaining its referenced history.
UPDATE membership_tiers
SET active = false, revision = revision + 1
WHERE active;

INSERT INTO membership_tiers (tiername, kind, tierprice, allottedmonths, benefits)
VALUES
  ('Monthly', 'membership', 95.00, 1, 'One calendar month of makerspace access.'),
  ('Day pass', 'day_pass', 25.00, NULL, 'One calendar day of makerspace access.');
