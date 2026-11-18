-- Marks a day-pass refund review raised only because Stripe's refund list and single-refund read
-- disagreed. A later read that agrees and records the full refund settles that review on its own.
-- A review raised for any other reason clears the mark, so staff still see it.
-- The constant default is metadata-only.
ALTER TABLE app_pass_checkout ADD COLUMN refund_review_inconsistent BOOLEAN NOT NULL DEFAULT false;
