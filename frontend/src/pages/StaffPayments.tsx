import { useState } from "react";
import { BillingRefunds } from "../components/BillingRefunds";
import { LoadState, Pager, PaymentList } from "../components/Management";
import { PaymentEditor } from "../components/staff/PaymentControls";
import type { Page, Payment } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

export function StaffPayments() {
  const [offset, setOffset] = useState(0),
    [userId, setUserId] = useState("");
  const payments = useApi<Page<Payment>>(
    `/admin/payments?offset=${offset}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`,
  );
  return (
    <section>
      <h2>Payment history</h2>
      <BillingRefunds />
      <p>
        External payment records and adjustments below do not move money. Stripe
        test refunds use the separate section above.
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
