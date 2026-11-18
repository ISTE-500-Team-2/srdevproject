-- Background reconciliation of lapsed studio card holds (backend/src/studios/service.ts) backs off
-- a hold that keeps failing, so a few holds whose checkout can't be reached are not rechecked with
-- Stripe on every pass and can't take every slot of a batch. Existing rows start with no failures;
-- the previous release ignores both columns.
ALTER TABLE app_studio_rental ADD COLUMN IF NOT EXISTS reconcile_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_studio_rental ADD COLUMN IF NOT EXISTS reconcile_after TIMESTAMPTZ;
