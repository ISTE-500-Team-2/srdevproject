-- Read-only. Run against each affected database while the previous app release handles webhooks.
SELECT c.id AS checkout_id, c.userid AS member_id, c.valid_date, c.checkout_id AS stripe_session_id,
       c.payment_intent AS stripe_payment_intent, c.amount_cents, c.payment_id, c.pass_id,
       c.status AS checkout_status, p.paymentstatus AS ledger_status, d.status AS pass_status,
       c.refund_id, c.refund_status, c.refund_needs_review, c.refund_reconcile_after,
       retired.original_checkout_id AS retired_by_checkout_id,
       (d.status IS NOT DISTINCT FROM 'active' AND c.refund_status IS NOT DISTINCT FROM 'succeeded') AS active_after_full_refund,
       ledger.payment_ids AS matching_stripe_payment_ids
FROM app_pass_checkout c
LEFT JOIN payment p ON p.paymentid = c.payment_id
LEFT JOIN day_pass d ON d.dayid = c.pass_id
LEFT JOIN LATERAL (
  SELECT a.after_state->>'checkoutId' AS original_checkout_id
  FROM app_staff_audit a
  WHERE a.subject_id = c.userid AND a.action = 'daypass.checkout.retired'
    AND a.after_state->>'retiredCheckoutId' = c.id::text
  ORDER BY a.id DESC LIMIT 1
) retired ON true
LEFT JOIN LATERAL (
  SELECT array_agg(other.paymentid ORDER BY other.paymentid) AS payment_ids
  FROM payment other
  WHERE other.userid = c.userid AND other.method = 'card' AND other.paymentstatus IN ('paid','refunded')
    AND other.reference IN (c.checkout_id, c.payment_intent)
) ledger ON true
WHERE c.refund_needs_review
   OR (c.payment_intent IS NOT NULL AND c.pass_id IS NULL AND
       (c.payment_id IS NULL OR p.paymentstatus = 'paid'))
   OR (c.refund_reconcile_after IS NOT NULL AND c.refund_status IS DISTINCT FROM 'partial')
   OR cardinality(ledger.payment_ids) > 1
   OR (c.refund_status = 'succeeded' AND (d.status IN ('active', 'suspended') OR p.paymentstatus IS DISTINCT FROM 'refunded'))
   OR (d.status IN ('active', 'suspended') AND retired.original_checkout_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app_staff_audit a
       WHERE a.subject_id = c.userid AND a.entity_type = 'payment' AND a.entity_id = c.payment_id
         AND a.action = 'billing.refund.reviewed' AND a.after_state->>'checkoutId' = c.id::text
         AND a.after_state->>'keptPassId' = c.pass_id::text))
ORDER BY c.valid_date, c.id;
