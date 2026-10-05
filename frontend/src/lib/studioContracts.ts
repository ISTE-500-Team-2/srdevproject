export type Studio = {
  id: number;
  name: string;
  size: string;
  monthly_cents: number | null;
  cancellation_policy: string | null;
  policy_confirmed: boolean;
  revision: number;
  availability: {
    starts_on: string;
    ends_on: string;
    status: string;
    hold_until: string;
  }[];
};
export type Rental = {
  id: number;
  name: string;
  starts_on: string;
  ends_on: string;
  amount_cents: number;
  status: string;
  payment_status: string;
  payment_method: string;
  hold_until: string;
  refund_cents: number;
  refund_id?: string | null;
  cancellation_policy: string;
  email?: string;
};
