-- Email is the sole account login in the new application. Keep the legacy
-- nullable column/index during blue-green coexistence: the previous application
-- still selects it and must remain a working rollback target. No names are
-- accepted, populated or exposed by the new application. Contract/drop requires
-- a separate rollout after legacy readers of this column have been retired.
COMMENT ON COLUMN "user".username IS
  'Deprecated compatibility data; current accounts authenticate by email only.';
