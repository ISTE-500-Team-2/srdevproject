-- Explicit staff-approved pricing/eligibility; no guessed discounts or schools.
CREATE TABLE app_billing_price (
 tierid INTEGER PRIMARY KEY REFERENCES membership_tiers(tierid),
 student_cents INTEGER CHECK(student_cents BETWEEN 0 AND 10000000),
 partner_free BOOLEAN NOT NULL DEFAULT false,
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE app_partner_eligibility (
 userid INTEGER PRIMARY KEY REFERENCES "user"(userid),
 reference TEXT NOT NULL,
 valid_until DATE NOT NULL,
 verified_by INTEGER NOT NULL REFERENCES "user"(userid),
 verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_membership_billing ADD COLUMN cancellation_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_membership_billing ADD COLUMN cancellation_requested_at TIMESTAMPTZ;
ALTER TABLE app_membership_billing ADD COLUMN cancellation_effective_at TIMESTAMPTZ;
CREATE TABLE app_pass_checkout (
 id UUID PRIMARY KEY,
 userid INTEGER NOT NULL REFERENCES "user"(userid),
 tierid INTEGER NOT NULL REFERENCES membership_tiers(tierid),
 valid_date DATE NOT NULL,
 plan_snapshot JSONB NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 0 AND 10000000),
 status TEXT NOT NULL DEFAULT 'pending',
 checkout_id TEXT UNIQUE,
 payment_intent TEXT UNIQUE,
 pass_id INTEGER UNIQUE REFERENCES day_pass(dayid),
 payment_id INTEGER UNIQUE REFERENCES payment(paymentid),
 cancel_requested_at TIMESTAMPTZ,
 refund_id TEXT UNIQUE,
 refund_status TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_pass_checkout_one_open ON app_pass_checkout(userid,valid_date)
 WHERE status NOT IN ('expired','cancelled');
CREATE TABLE app_pass_stripe_event(id TEXT PRIMARY KEY,received_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE app_payment_security_event (
 id BIGSERIAL PRIMARY KEY,
 kind TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
