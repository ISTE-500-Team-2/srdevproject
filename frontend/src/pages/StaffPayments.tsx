import { useState } from "react";
import { BillingRefunds } from "../components/BillingRefunds";
import { MemberSelect } from "../components/MemberSelect";
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
        These records track payments taken at the front desk. Changing them doesn't charge or refund a card.
      </p>
      <div className="management-search">
        {/* Picking a member filters straight away; Change clears it. */}
        <MemberSelect
          label="Filter by member"
          required={false}
          value={userId}
          onChange={(id) => {
            setUserId(id);
            setOffset(0);
          }}
        />
      </div>
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
