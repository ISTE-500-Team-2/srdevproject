import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { dollars } from "../../../lib/display";
import type { Page, Payment } from "../../../lib/staffContracts";
import { paymentAction, paymentMethodName, paymentStatusName, paymentStatusTone, refundNote } from "../PaymentControls";
import { day, Row, type OpenDialog } from "./recordParts";

/** The member's latest payments, each with the one change staff can make to it. */
export function RecordPayments({ personId, payments, canManage, open }: { personId: number; payments: Page<Payment>; canManage: boolean; open: OpenDialog }) {
  return (
    <section className="today-panel" aria-labelledby={`mr-pay-title-${personId}`}>
      <div className="today-panel-head">
        <h2 id={`mr-pay-title-${personId}`}>Payments</h2>
        <span className="today-count">{payments.items.length}{payments.nextOffset != null ? "+" : ""}</span>
      </div>
      {payments.items.length ? (
        payments.items.slice(0, 6).map((p) => {
          const action = canManage ? paymentAction(p) : null;
          const note = refundNote(p);
          return (
            <Row
              key={p.id}
              icon="receipt"
              title={p.planName || "Payment"}
              detail={`${day(p.recordedAt)} · ${paymentMethodName(p.method)}${p.reference ? ` · ${p.reference}` : ""} · #${p.id}`}
              end={
                <>
                  <strong>{dollars(p.amount)}</strong>
                  <span className="mr-row__pills">
                    <span className={`status-pill status-pill--${paymentStatusTone(p.status)}`}>{paymentStatusName(p.status)}</span>
                    {note ? <span className={`status-pill ${note === "Refund failed" ? "status-pill--danger" : "status-pill--warn"}`}>{note}</span> : null}
                    {action ? (
                      <button
                        type="button"
                        className="today-link"
                        aria-label={`${action === "refund" ? "Refund" : "Update"} payment #${p.id}`}
                        onClick={() => open(action === "refund" ? { kind: "refund", payment: p } : { kind: "payment", payment: p })}
                      >
                        {action === "refund" ? "Refund…" : "Update"}
                      </button>
                    ) : null}
                  </span>
                </>
              }
            />
          );
        })
      ) : (
        <p className="today-empty">No payments recorded.</p>
      )}
      {payments.items.length ? (
        <div className="today-panel-foot">
          <Link className="today-link" to="/admin/payments">
            {payments.items.length > 6 || payments.nextOffset != null ? "All payments" : "Open Payments"} <ChevronRight aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
