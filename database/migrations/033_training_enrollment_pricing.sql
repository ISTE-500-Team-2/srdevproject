-- Record the one-time training fee on the class registration, not equipment use.
ALTER TABLE app_training_enrollment ADD COLUMN training_fee_cents INTEGER
  CHECK (training_fee_cents BETWEEN 0 AND 10000000);
ALTER TABLE app_training_enrollment ADD COLUMN payment_id INTEGER UNIQUE REFERENCES payment(paymentid);
