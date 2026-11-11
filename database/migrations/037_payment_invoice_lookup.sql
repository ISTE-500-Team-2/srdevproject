-- The staff payments list looks up each card payment's Stripe invoice by payment.
CREATE INDEX IF NOT EXISTS app_membership_invoice_payment ON app_membership_invoice(payment_id, period_start DESC);
