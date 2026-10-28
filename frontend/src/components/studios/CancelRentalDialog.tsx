import { CircleAlert, CircleCheck, X } from "lucide-react";
import { Modal } from "../Modal";
import HoldButton from "../reactbits/HoldButton";
import type { Rental } from "../../lib/studioContracts";
import { money, policy, rentalRange } from "../../lib/studioDisplay";

/** Says plainly what the member gets back, and why when it's nothing. */
function refundLine(r: Rental, refundable: number, started: boolean) {
  if (refundable > 0)
    return { ok: true, text: `You'll get ${money(refundable)} back to your original payment method.` };
  if (r.payment_status !== "paid")
    return { ok: true, text: "You haven't paid for this hold, so there's nothing to refund." };
  if (r.cancellation_policy === "no_refunds")
    return { ok: false, text: `This rental's terms don't include refunds, so the ${money(r.amount_cents)} you paid won't be returned.` };
  return {
    ok: false,
    text: started
      ? `The rental has already started, so the ${money(r.amount_cents)} you paid won't be returned.`
      : `The ${money(r.amount_cents)} you paid won't be returned.`,
  };
}

export function CancelRentalDialog({
  rental,
  refundable,
  started,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  rental: Rental;
  refundable: number;
  started: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const refund = refundLine(rental, refundable, started);
  const Icon = refund.ok ? CircleCheck : CircleAlert;
  return (
    <Modal open width="compact" title={`Cancel ${rental.name}?`} onClose={onClose}>
      <div className="cancel-rental">
        <p className="cancel-rental__dates">{rentalRange(rental.starts_on, rental.ends_on)}</p>
        <p className={`cancel-rental__refund cancel-rental__refund--${refund.ok ? "ok" : "warn"}`}>
          <Icon aria-hidden="true" />
          <span>{refund.text}</span>
        </p>
        <p className="cancel-rental__policy">
          {policy(rental.cancellation_policy)}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="cancel-rental__actions">
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>
            Keep rental
          </button>
          <HoldButton
            className="site-hold-button"
            disabled={busy}
            holdTime={1200}
            radius={9}
            backgroundColor="#fff5f3"
            fillColor="#b73a2e"
            textColor="#b73a2e"
            fillTextColor="#ffffff"
            icon={<X size={16} aria-hidden="true" />}
            doneLabel="Cancelling…"
            onHold={onConfirm}
          >
            Hold to cancel rental
          </HoldButton>
        </div>
      </div>
    </Modal>
  );
}
