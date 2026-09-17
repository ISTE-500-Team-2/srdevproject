-- Registration DOB support. 004 is reserved by the open refresh-token PR.
-- Existing users have unknown birthdays: preserve them as NULL, not a fake date.
-- Registration validation must require DOB for new signups at the API boundary.
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS dob DATE;
