export type StudioCancellationPolicy = "full_before_start" | "no_refunds";
export type StudioPaymentMethod = "manual" | "stripe_test";

/** An app_studio row. */
export interface StudioRow {
  id: number;
  name: string;
  size: "small" | "medium" | "large";
  monthly_cents: number | null;
  cancellation_policy: StudioCancellationPolicy | null;
  policy_confirmed: boolean;
  active: boolean;
  revision: number;
}

/** An app_studio_rental row; pg returns its DATE columns as Date objects. */
export interface StudioRentalRow {
  id: number;
  studio_id: number;
  userid: number;
  starts_on: Date | string;
  ends_on: Date | string;
  amount_cents: number;
  cancellation_policy: StudioCancellationPolicy;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  payment_status: "unpaid" | "paid" | "refund_pending" | "refunded" | "refund_failed";
  payment_method: StudioPaymentMethod;
  request_key: string;
  checkout_id: string | null;
  payment_intent: string | null;
  refund_id: string | null;
  payment_reference: string | null;
  refund_reference: string | null;
  refund_cents: number;
  created_at: Date;
  hold_until: Date;
}

/** A row with its rental dates rendered as YYYY-MM-DD strings. */
export type WithRentalDates<T extends { starts_on: Date | string; ends_on: Date | string }> =
  Omit<T, "starts_on" | "ends_on"> & { starts_on: string; ends_on: string };

/** A rental joined with its studio name. */
export interface NamedStudioRentalRow extends StudioRentalRow {
  name: string;
}

/** The fields a Stripe test checkout is created from. */
export type StudioCheckoutRental = Pick<
  WithRentalDates<StudioRentalRow>,
  "id" | "hold_until" | "amount_cents" | "starts_on" | "ends_on"
>;

/** The fields a Stripe test refund is requested from. */
export type StudioRefundRental = Pick<StudioRentalRow, "id" | "payment_intent" | "refund_cents">;

/** Studio rate/policy update; each field is validated by StudioService.configure. */
export interface StudioConfigureRequest {
  [field: string]: unknown;
  cancellationPolicy?: unknown;
  policyConfirmed?: unknown;
  monthlyCents?: unknown;
  revision?: unknown;
}

/** Studio rental request; each field is validated by StudioService.create. */
export interface StudioRentalRequest {
  [field: string]: unknown;
  startDate?: unknown;
  studioId?: unknown;
  requestKey?: unknown;
  paymentMethod?: unknown;
  expectedRevision?: unknown;
}
