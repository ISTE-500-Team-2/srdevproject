import { useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Page, Payment } from "../lib/staffContracts";
import {
  ActionForm,
  Field,
  LoadState,
  Pager,
  PaymentList,
  ReasonField,
} from "../components/Management";

export function PaymentMethod({ value = "unspecified" }: { value?: string }) {
  return (
    <Field label="Payment method" name="method">
      <select name="method" defaultValue={value}>
        <option value="unspecified">Not received / unspecified</option>
        <option value="cash">Cash</option>
        <option value="external_card">Card received outside this app</option>
        <option value="bank_transfer">Bank transfer</option>
        <option value="other">Other external method</option>
      </select>
    </Field>
  );
}
export function PaymentEditor({
  payment,
  onSaved,
}: {
  payment: Payment;
  onSaved: () => void;
}) {
  const transitions: Record<string, string[]> = {
    pending: ["paid", "void", "waived"],
    paid: ["refunded"],
  };
  const options = transitions[payment.status] ?? [];
  if (!options.length)
    return <p>This status is final; the history is retained.</p>;
  return (
    <details>
      <summary>Update payment #{payment.id}</summary>
      <ActionForm
        title={`Payment record ${payment.id}`}
        submitLabel="Update payment record"
        onSubmit={async (f) => {
          await api(`/admin/payments/${payment.id}/status`, {
            method: "POST",
            body: {
              status: f.get("status"),
              method: f.get("method"),
              reference: f.get("reference"),
              reason: f.get("reason"),
              revision: payment.revision,
            },
          });
          onSaved();
        }}
      >
        <p>
          Record only what happened outside this app. This does not charge a
          card, send a refund, or change facility access.
        </p>
        <Field label="New payment status" name="status">
          <select name="status">
            {options.map((s) => (
              <option key={s} value={s}>
                {s === "paid"
                  ? "Paid externally"
                  : s === "refunded"
                    ? "Refunded externally"
                    : s}
              </option>
            ))}
          </select>
        </Field>
        <PaymentMethod value={payment.method} />
        <Field
          label="External receipt/reference (no card details)"
          name="reference"
          defaultValue={payment.reference}
          required={false}
          maxLength={100}
        />
        <ReasonField />
      </ActionForm>
    </details>
  );
}
export function StaffPayments() {
  const [offset, setOffset] = useState(0),
    [userId, setUserId] = useState("");
  const payments = useApi<Page<Payment>>(
    `/admin/payments?offset=${offset}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`,
  );
  return (
    <section>
      <h2>Payment history</h2>
      <p>
        Recorded receipts and adjustments. No money is moved by this
        application.
      </p>
      <form
        className="management-search"
        onSubmit={(e) => {
          e.preventDefault();
          setUserId(String(new FormData(e.currentTarget).get("userId") ?? ""));
          setOffset(0);
        }}
      >
        <label>
          Filter by member ID <input name="userId" type="number" min="1" />
        </label>
        <button className="button button--quiet">Filter records</button>
      </form>
      <LoadState {...payments} />
      {payments.data ? (
        <>
          <PaymentList
            page={payments.data}
            actions={(p) => (
              <PaymentEditor
                key={`${p.id}-${p.revision}`}
                payment={p}
                onSaved={payments.reload}
              />
            )}
          />
          <Pager
            offset={offset}
            nextOffset={payments.data.nextOffset}
            onChange={setOffset}
          />
        </>
      ) : null}
    </section>
  );
}
