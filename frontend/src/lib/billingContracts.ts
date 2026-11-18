// Browser shapes for billing responses; monetary amounts marked Cents are integer minor units, not
// dollar values.

import type { Plan } from "./staffContracts";

export type Offer = Plan & {
  amountCents: number;
  pricingRevision: number;
  basis: string;
};
export interface Billing {
  id: string;
  status: string;
  plan: Plan;
  amountCents: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  cancellationEffectiveAt?: string | null;
  cancellationConfirmed?: boolean;
}
export interface Invoice {
  id: string;
  userId: number;
  planName: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  refundStatus: string | null;
}
export interface SignedWaiver {
  id: number;
  waiverId: number;
  name: string;
  version: string;
  signedAt: string;
  expiresAt: string | null;
  approved: boolean;
  copyAvailable: boolean;
}
export interface BillingPass {
  id: string;
  plan: Plan;
  validDate: string;
  cancelBy: string;
  status: string;
  refundStatus: string | null;
  amountCents: number;
  /** The member's cancellation is on record, so a failed refund can be retried after the cancel-by deadline. */
  cancelRequested?: boolean;
  /** False for a card payment that arrived when no pass could be issued; only its refund remains. */
  passIssued?: boolean;
}
export interface EligibilityPrice {
  tierid: number;
  student_cents: number | null;
  partner_free: boolean;
  revision: number;
}
