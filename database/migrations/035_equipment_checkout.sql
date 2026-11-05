-- Existing reservations retain their status and payment history.
CREATE TABLE app_equipment_checkout (
 reservation_id integer PRIMARY KEY REFERENCES reservation(reservationid),
 payer_id integer NOT NULL REFERENCES "user"(userid),
 request_key uuid NOT NULL,
 equipment_name text NOT NULL,
 hourly_cents integer NOT NULL CHECK(hourly_cents > 0),
 hours integer NOT NULL CHECK(hours BETWEEN 1 AND 24),
 amount_cents integer NOT NULL CHECK(amount_cents = hourly_cents * hours AND amount_cents >= 50),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired')),
 checkout_id text UNIQUE,
 payment_intent text UNIQUE,
 payment_id integer UNIQUE REFERENCES payment(paymentid),
 created_at timestamptz NOT NULL DEFAULT now(),
 hold_until timestamptz NOT NULL DEFAULT now() + interval '31 minutes',
 UNIQUE(payer_id,request_key)
);
CREATE INDEX app_equipment_checkout_pending ON app_equipment_checkout(hold_until) WHERE status='pending';
CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON app_equipment_checkout
 FOR EACH ROW EXECUTE FUNCTION app_capture_change('reservation_id');
CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON app_equipment_checkout
 FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation();
