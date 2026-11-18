-- Read-only. Run against each affected database while the previous app release handles webhooks.
SELECT c.id AS checkout_id, c.userid AS member_id, c.valid_date, c.checkout_id AS stripe_session_id,
       c.payment_intent AS stripe_payment_intent, c.amount_cents, c.payment_id, c.pass_id,
       c.status AS checkout_status, p.paymentstatus AS ledger_status,
       c.refund_id, c.refund_status, c.refund_needs_review, c.refund_reconcile_after
FROM app_pass_checkout c
JOIN payment p ON p.paymentid = c.payment_id
WHERE c.payment_intent IS NOT NULL
  AND (c.refund_reconcile_after IS NOT NULL OR c.refund_needs_review
       OR (c.status = 'pending' AND c.pass_id IS NULL))
ORDER BY c.valid_date, c.id;
