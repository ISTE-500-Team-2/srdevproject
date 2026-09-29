-- Additive studio rentals, separate from hourly equipment reservations.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE app_studio (
 id serial PRIMARY KEY, name text NOT NULL UNIQUE, size text NOT NULL CHECK(size IN ('small','medium','large')),
 monthly_cents integer CHECK(monthly_cents BETWEEN 50 AND 10000000),
 cancellation_policy text CHECK(cancellation_policy IN ('full_before_start','no_refunds')),
 policy_confirmed boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1
);
INSERT INTO app_studio(name,size) VALUES ('Small studio 1','small'),('Small studio 2','small'),('Small studio 3','small'),
 ('Medium studio 1','medium'),('Medium studio 2','medium'),('Medium studio 3','medium'),('Large studio 1','large'),('Large studio 2','large');
CREATE TABLE app_studio_rental (
 id serial PRIMARY KEY, studio_id integer NOT NULL REFERENCES app_studio(id), userid integer NOT NULL REFERENCES "user"(userid),
 starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>starts_on), amount_cents integer NOT NULL CHECK(amount_cents>0),
 cancellation_policy text NOT NULL CHECK(cancellation_policy IN ('full_before_start','no_refunds')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled','expired')),
 payment_status text NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','refund_pending','refunded','refund_failed')),
 payment_method text NOT NULL CHECK(payment_method IN ('manual','stripe_test')),
 request_key uuid NOT NULL, checkout_id text UNIQUE, payment_intent text UNIQUE, refund_id text UNIQUE,
 payment_reference text, refund_reference text, refund_cents integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), hold_until timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(userid,request_key),
 EXCLUDE USING gist (studio_id WITH =, daterange(starts_on,ends_on,'[)') WITH &&) WHERE(status IN ('pending','confirmed'))
);
CREATE TABLE app_studio_event (id bigserial PRIMARY KEY,rental_id integer REFERENCES app_studio_rental(id),
 actor_id integer REFERENCES "user"(userid), event text NOT NULL, details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_studio_stripe_event (id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX app_studio_rental_user ON app_studio_rental(userid);
