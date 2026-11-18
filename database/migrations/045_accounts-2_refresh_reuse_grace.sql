-- When each refresh token was used up. Two tabs renewing with the same cookie, or a reload
-- that lost the refresh response, present a token that was rotated moments ago; within a
-- short grace window that is not treated as theft (backend/src/models/SessionModel.ts).
-- Tokens consumed before this column existed stay NULL, so their reuse still ends the
-- sign-in. The previous release never reads or writes the column.
ALTER TABLE app_refresh_token ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
