CREATE TABLE IF NOT EXISTS public.account_preferences (
  userid INTEGER PRIMARY KEY REFERENCES public."user"(userid) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{"notifications":{"reservations":true,"classes":true,"membershipPayments":true},"accessibility":{"largeText":false,"highContrast":false,"reducedMotion":false}}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_preferences_shape CHECK (
    jsonb_typeof(preferences->'notifications') = 'object' AND
    jsonb_typeof(preferences->'accessibility') = 'object'
  )
);
