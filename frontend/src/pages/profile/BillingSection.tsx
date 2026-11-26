import { ChevronRight, CreditCard } from "lucide-react";
import { Link } from "react-router-dom";
import { dollars, shortDate } from "../../lib/display";
import type { MembershipHistory, Page, Payment } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { Detail, Section } from "../profileSections";

export function BillingSection() {
  const history = useApi<MembershipHistory>("/me/memberships");
  // Only payments actually made: an abandoned or unfinished checkout leaves a void or pending row.
  const payments = useApi<Page<Payment>>("/me/payments?offset=0&status=paid");
  const membership = history.data?.memberships.find((m) => m.effectiveStatus === "active");
  const pass = history.data?.passes.find((p) => p.effectiveStatus === "active");
  const current = membership ?? pass;
  const last = payments.data?.items[0];
  return (
    <Section
      id="billing"
      title="Membership & billing"
      note="Your plan, current period and latest payment."
      Icon={CreditCard}
      action={
        <Link className="button button--primary account-edit" to="/membership">
          Manage <ChevronRight aria-hidden="true" />
        </Link>
      }
    >
      {history.error || payments.error ? <p className="form-error">{history.error || payments.error}</p> : null}
      <div className="account-plan">
        <div>
          <strong className="account-plan__name">
            {current?.plan?.name ?? (history.data ? "No active plan" : history.error ? "Plan unavailable" : "…")}
          </strong>
          {current ? (
            <span className="status-pill status-pill--ok">{membership ? "Active" : "Day pass today"}</span>
          ) : null}
        </div>
        <dl className="account-details account-details--inline">
          {/* With no plan or pass there is no period to show; the name above already says so. */}
          {current ? (
            <Detail label={membership ? "Current period ends" : "Valid"}>
              {membership?.endsAt
                ? shortDate(membership.endsAt, true)
                : pass?.validDate
                  ? shortDate(pass.validDate, true)
                  : ""}
            </Detail>
          ) : null}
          <Detail label="Latest payment" empty={payments.error ? "Unavailable" : "Loading…"}>
            {last ? `${dollars(last.amount)} · ${shortDate(last.recordedAt)}` : payments.data ? "None yet" : ""}
          </Detail>
        </dl>
      </div>
    </Section>
  );
}
