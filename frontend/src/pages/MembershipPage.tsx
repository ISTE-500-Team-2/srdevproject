import { useState } from "react";
import { useApi } from "../lib/useApi";
import type {
  MembershipHistory,
  Page,
  Payment,
  Plan,
} from "../lib/staffContracts";
import {
  EntitlementList,
  LoadState,
  Pager,
  PaymentList,
  dollars,
} from "../components/Management";

export function MembershipPage() {
  const history = useApi<MembershipHistory>("/me/memberships"),
    plans = useApi<Plan[]>("/plans"),
    [offset, setOffset] = useState(0);
  const payments = useApi<Page<Payment>>(`/me/payments?offset=${offset}`);
  return (
    <div className="page-enter management-page">
      <h1>Membership & passes</h1>
      <LoadState {...history} />
      {history.data ? (
        <section className="panel management-panel">
          <h2>Your access records</h2>
          <p>
            Facility access: <strong>{history.data.accessStatus}</strong>.
            Day-pass dates use {history.data.timeZone}. Membership times below
            use your local timezone. Showing the latest 100 of each record type.
          </p>
          <EntitlementList
            memberships={history.data.memberships}
            passes={history.data.passes}
          />
          <p>
            Contact staff to issue, renew, or adjust a membership or day pass.
          </p>
        </section>
      ) : null}
      <section className="panel management-panel">
        <h2>Available plans</h2>
        <LoadState {...plans} />
        <div className="management-records">
          {plans.data?.map((p) => (
            <article className="management-record" key={p.id}>
              <h3>{p.name}</h3>
              <p>
                {dollars(p.price)} ·{" "}
                {p.kind === "day_pass"
                  ? "One calendar day"
                  : `${p.months} calendar month(s)`}
              </p>
              <p>{p.benefits}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="panel management-panel">
        <h2>Your payment history</h2>
        <LoadState {...payments} />
        {payments.data ? (
          <>
            <PaymentList page={payments.data} />
            <Pager
              offset={offset}
              nextOffset={payments.data.nextOffset}
              onChange={setOffset}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
