-- Password-aware confirmation marks rows it stages or resends. A rolled-back
-- release must be unable to put a one-click token on those rows via its resend path.
-- The constant default is metadata-only. Validate after commit so writes can continue.
ALTER TABLE app_pending_registration
  ADD COLUMN confirmation_requires_password BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT app_pending_registration_password_confirmation
    CHECK (NOT confirmation_requires_password OR token_hash IS NULL OR token_hash LIKE 'v2:%') NOT VALID;
