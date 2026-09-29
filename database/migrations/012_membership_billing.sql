-- Separate one-time rentals from recurring memberships; never migrate existing
-- members into automatic billing or store card details.
CREATE TABLE app_membership_billing (
  id UUID PRIMARY KEY,
  userid INTEGER NOT NULL REFERENCES "user"(userid),
  tierid INTEGER NOT NULL REFERENCES membership_tiers(tierid),
  plan_snapshot JSONB NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 50),
  checkout_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  current_period_end TIMESTAMPTZ,
  consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_membership_billing_one_open ON app_membership_billing(userid)
  WHERE status NOT IN ('canceled','incomplete_expired','expired');
CREATE TABLE app_membership_invoice (
  id TEXT PRIMARY KEY,
  billing_id UUID NOT NULL REFERENCES app_membership_billing(id),
  membership_id INTEGER NOT NULL REFERENCES user_membership(membershipid),
  payment_id INTEGER NOT NULL REFERENCES payment(paymentid),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  UNIQUE(billing_id,period_start,period_end)
);
CREATE TABLE app_membership_stripe_event (
  id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_membership_invoice ADD COLUMN payment_intent TEXT UNIQUE;
ALTER TABLE app_membership_invoice ADD COLUMN refund_id TEXT UNIQUE;
ALTER TABLE app_membership_invoice ADD COLUMN refund_status TEXT;
