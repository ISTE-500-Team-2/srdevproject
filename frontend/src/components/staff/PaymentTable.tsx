import { Fragment, useRef } from "react";
import { dollars, shortDate } from "../../lib/display";
import type { Payment } from "../../lib/staffContracts";
import {
  CardRefund,
  PaymentEditor,
  paymentAction,
  paymentMethodName,
  paymentStatusName,
  paymentStatusTone,
  refundNote,
} from "./PaymentControls";
import "./paymentTable.css";

const time = (value: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
const thisYear = new Date().getFullYear();

/**
 * Payments as a table, newest first. A row opens its editor (front-desk records)
 * or card refund in place; `onChanged` gets a sentence saying what happened.
 */
export function PaymentTable({
  items,
  caption,
  open,
  onOpen,
  onChanged,
  showMember = true,
  canManage = true,
}: {
  items: Payment[];
  caption: string;
  open: number | null;
  onOpen: (id: number | null) => void;
  onChanged: (message: string) => void;
  showMember?: boolean;
  canManage?: boolean;
}) {
  const columns = showMember ? 7 : 6;
  const region = useRef<HTMLDivElement>(null);
  /** After a save the form is gone: return focus to the row's button, or to the table if the row has no action now. */
  const finish = (payment: Payment, stillActionable: boolean, message: string) => {
    onOpen(null);
    onChanged(message);
    requestAnimationFrame(() => {
      const button = stillActionable ? document.getElementById(`payment-${payment.id}-action`) : null;
      (button ?? region.current)?.focus();
    });
  };
  return (
    <div className="payment-table table-scroll" role="region" aria-label="Payments" tabIndex={0} ref={region}>
      <table className={showMember ? undefined : "payment-table--one-member"}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Recorded</th>
            {showMember ? <th scope="col">Member</th> : null}
            <th scope="col">For</th>
            <th scope="col">Method</th>
            <th scope="col">Status</th>
            <th scope="col" className="payment-table__amount">
              Amount
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const action = canManage ? paymentAction(p) : null;
            const note = refundNote(p);
            const isOpen = open === p.id && action !== null;
            const detailId = `payment-${p.id}-detail`;
            const recorded = new Date(p.recordedAt);
            return (
              <Fragment key={p.id}>
                <tr className={isOpen ? "is-open" : undefined}>
                  <td data-label="Recorded">
                    <span className="payment-table__main">
                      {shortDate(recorded, recorded.getFullYear() !== thisYear)}
                    </span>
                    <small>
                      {time(p.recordedAt)} · #{p.id}
                    </small>
                  </td>
                  {showMember ? (
                    <td data-label="Member">
                      <span className="payment-table__main">{p.memberName}</span>
                    </td>
                  ) : null}
                  <td data-label="For">{p.planName}</td>
                  <td data-label="Method">
                    {paymentMethodName(p.method)}
                    {p.reference ? <small>Ref {p.reference}</small> : null}
                  </td>
                  <td data-label="Status">
                    <span className="payment-table__status">
                      <span className={`status-pill status-pill--${paymentStatusTone(p.status)}`}>
                        {paymentStatusName(p.status)}
                      </span>
                      {note ? (
                        <span className={`status-pill ${note === "Refund failed" ? "payment-table__failed" : "status-pill--warn"}`}>
                          {note}
                        </span>
                      ) : null}
                    </span>
                    {note === "Refund failed" ? <small>Check this refund in Stripe.</small> : null}
                  </td>
                  <td data-label="Amount" className="payment-table__amount">
                    {dollars(p.amount)}
                  </td>
                  <td className="payment-table__action">
                    {action ? (
                      <button
                        type="button"
                        id={`payment-${p.id}-action`}
                        className="button button--quiet payment-table__button"
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? detailId : undefined}
                        aria-label={`${isOpen ? "Close" : action === "refund" ? "Refund" : "Update"} payment #${p.id} for ${p.memberName}`}
                        onClick={() => onOpen(isOpen ? null : p.id)}
                      >
                        {isOpen ? "Close" : action === "refund" ? "Refund…" : "Update"}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="payment-table__detail" id={detailId}>
                    <td colSpan={columns}>
                      {action === "refund" ? (
                        <CardRefund
                          payment={p}
                          onRefunded={(result) =>
                            finish(
                              p,
                              false,
                              result === "succeeded"
                                ? `Refunded ${dollars(p.amount)} to ${p.memberName}'s card.`
                                : result === "pending" || result === "requires_action"
                                  ? `Refund of ${dollars(p.amount)} to ${p.memberName}'s card is on its way.`
                                  : `Stripe didn't complete the refund to ${p.memberName}'s card. Check it in Stripe.`,
                            )
                          }
                        />
                      ) : (
                        <PaymentEditor
                          key={`${p.id}-${p.revision}`}
                          payment={p}
                          onSaved={(next) =>
                            finish(
                              p,
                              paymentAction({ ...p, status: next }) !== null,
                              `Payment #${p.id} for ${p.memberName} is now ${paymentStatusName(next).toLowerCase()}.`,
                            )
                          }
                        />
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
