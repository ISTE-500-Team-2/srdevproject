// Member monthly-rental form; date/availability feedback is advisory until the server accepts the
// booking.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, CircleAlert, CreditCard } from "lucide-react";
import { MonthCalendar } from "../MonthCalendar";
import { Modal } from "../Modal";
import { BookingReference } from "./BookingReference";
import type { Rental, Studio } from "../../lib/studioContracts";
import {
  addDays,
  nextMonth,
  calendarDate,
  conflictFor,
  dateOnly,
  freeFor,
  money,
  nextOpening,
  rentalRange,
  sizeLabel,
} from "../../lib/studioDisplay";

export type BookingRequest = {
  studio: Studio;
  startDate: string;
  paymentMethod: "manual" | "stripe_test";
};

export function StudioBooking({
  size,
  studios,
  today,
  cardEnabled,
  canBook,
  blockedReason,
  busy,
  error,
  notice,
  held,
  mine,
  onClose,
  onBook,
  onFinish,
}: {
  size: string | null;
  studios: Studio[];
  today: string;
  cardEnabled: boolean;
  canBook: boolean;
  blockedReason: string;
  busy: boolean;
  error: string;
  /** The outcome of an action taken in this pop-up, such as Finish card payment. */
  notice: string;
  held: Rental | null;
  /** The member's own rentals, so their own new hold never reads as taken by someone else. */
  mine: Rental[];
  onClose: () => void;
  onBook: (request: BookingRequest) => void;
  onFinish: (rental: Rental) => void;
}) {
  const opening = useMemo(
    () => nextOpening(studios, today) ?? today,
    [studios, today],
  );
  const [start, setStart] = useState("");
  const [month, setMonth] = useState(opening.slice(0, 7));
  const [studioId, setStudioId] = useState<number | null>(null);
  const [method, setMethod] = useState<"manual" | "stripe_test">("manual");
  const end = nextMonth(start);
  const choice = studios.find((s) => s.id === studioId) ?? null;
  // The member's own rental for exactly this choice (a card checkout they started, or a booking
  // whose reply was lost after the server saved it) is theirs, not "just taken": show it.
  const yours =
    held ??
    (choice && start
      ? mine.find(
          (r) =>
            ["pending", "confirmed"].includes(r.status) &&
            r.studio_id === choice.id &&
            dateOnly(r.starts_on) === start,
        )
      : null) ??
    null;
  // Availability refreshes while the pop-up is open; re-check the current
  // choice so a studio someone else just took can't be submitted.
  const dateTaken = !!start && !studios.some((s) => freeFor(s, start));
  const choiceTaken = !!choice && !!start && !!conflictFor(choice, start, end);
  const stale = dateTaken
    ? "That start date was just taken. Pick another date."
    : choiceTaken
      ? `${choice!.name} was just taken for these dates. Pick another studio.`
      : "";
  const pick = (date: string) => {
    setStart(date);
    const keep = choice && freeFor(choice, date);
    if (!keep) setStudioId(studios.find((s) => freeFor(s, date))?.id ?? null);
  };
  const label = size ? sizeLabel(size).toLowerCase() : "";
  return (
    <Modal open={!!size} title={`Reserve a ${label} studio`} onClose={onClose}>
      {notice && (
        <p className="studio-message studio-booking__notice" role="status">
          {notice}
        </p>
      )}
      {yours ? (
        <div className="studio-held" role="status">
          <div className="studio-held__head">
            <div>
              <h3>
                {yours.name} is {yours.status === "confirmed" ? "booked" : "held"} for you
              </h3>
              <p>
                {rentalRange(yours.starts_on, yours.ends_on)} · {money(yours.amount_cents)}
              </p>
            </div>
            <BookingReference id={yours.id} />
          </div>
          {yours.status === "pending" && (
            <p className="form-notice">
              <CircleAlert aria-hidden="true" />
              <span>
                {yours.payment_method === "manual"
                  ? "Pay at the front desk by "
                  : "Card payment isn’t finished. Pay by "}
                <strong>
                  {new Date(yours.hold_until).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </strong>{" "}
                {yours.payment_method === "manual"
                  ? "and give them your booking reference. After that the hold is released."
                  : "or the hold is released."}
              </span>
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="studio-booking__foot">
            <span>
              {yours.status === "pending"
                ? "It’s listed under Your rentals until it’s paid."
                : "It’s listed under Your rentals."}
            </span>
            {yours.status === "pending" && yours.payment_method === "stripe_test" && (
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => onFinish(yours)}
              >
                <CreditCard aria-hidden="true" />
                Finish card payment
              </button>
            )}
            <button type="button" className="button button--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="studio-booking"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice && start && !stale && canBook && !busy && (method !== "stripe_test" || cardEnabled))
              onBook({ studio: choice, startDate: start, paymentMethod: method });
          }}
        >
          {!canBook && (
            <p className="form-notice studio-booking__gate">
              <CircleAlert aria-hidden="true" />
              <span>
                {blockedReason}{" "}
                <Link to="/membership">See membership options</Link>
              </span>
            </p>
          )}
          <div className="studio-booking__cols">
            <fieldset>
              <legend className="equipment-booking-step">
                <span>1</span>Start date
              </legend>
              <MonthCalendar
                month={month}
                setMonth={setMonth}
                today={today}
                selected={start}
                isValid={(date) => studios.some((s) => freeFor(s, date))}
                onSelect={pick}
              />
              <p className="studio-booking__hint">
                {start
                  ? `Yours through ${calendarDate(addDays(end, -1))}.`
                  : "Choose a start date to continue. Rentals run one calendar month. Crossed-out days have no studio free for a full month."}
              </p>
            </fieldset>
            <div>
              <fieldset>
                <legend className="equipment-booking-step">
                  <span>2</span>Studio
                </legend>
                <div>
                  {studios.map((s) => {
                    const blocked = start ? conflictFor(s, start, end) : undefined;
                    // Back-to-back or later rentals can keep it busy past the first one found.
                    const free = blocked ? nextOpening([s], start) : null;
                    return (
                      <label
                        key={s.id}
                        className="choice-card"
                      >
                        <input
                          type="radio"
                          name="studio"
                          checked={studioId === s.id}
                          disabled={busy || !!blocked}
                          onChange={() => setStudioId(s.id)}
                        />
                        <span>
                          <strong>{s.name}</strong>
                          <small>
                            {blocked
                              ? free
                                ? `Next opening ${calendarDate(free, { month: "short", day: "numeric" })}`
                                : "Fully booked"
                              : money(s.monthly_cents ?? 0) + " / month"}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset>
                <legend className="equipment-booking-step">
                  <span>3</span>Payment
                </legend>
                <div>
                  <label className="choice-card">
                    <input
                      type="radio"
                      name="payment"
                      checked={method === "manual"}
                      onChange={() => setMethod("manual")}
                    />
                    <span>
                      <strong>Pay at the front desk</strong>
                      <small>We hold the studio for 30 minutes.</small>
                    </span>
                  </label>
                  {(
                    <label className="choice-card">
                      <input
                        type="radio"
                        name="payment"
                        disabled={!cardEnabled || busy}
                        checked={method === "stripe_test"}
                        onChange={() => setMethod("stripe_test")}
                      />
                      <span>
                        <strong>Pay now by card</strong>
                        <small>{cardEnabled ? "Test mode — no real charge." : "Not available right now. Pay at the front desk instead."}</small>
                      </span>
                    </label>
                  )}
                </div>
              </fieldset>
              {choice && start && (
                <dl className="studio-summary">
                  <div>
                    <dt>
                      <strong>{choice.name}</strong>
                      <small>{rentalRange(start, end)}</small>
                    </dt>
                    <dd>{money(choice.monthly_cents ?? 0)}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
          {/* A server error always shows. It already explains a conflict, so the
              stale notice only speaks when there is no error. */}
          {(error || stale) && (
            <p className="form-error" role="alert">
              {error || stale}
            </p>
          )}
          <div className="studio-booking__foot">
            <span>
              {choice?.cancellation_policy === "full_before_start" && start
                ? start <= today
                  ? "No refund: this rental starts today."
                  : `Full refund if you cancel before ${calendarDate(start, { month: "short", day: "numeric" })}.`
                : choice?.cancellation_policy === "no_refunds"
                  ? "No refunds once booked."
                  : ""}
            </span>
            <button
              className="button button--primary"
              disabled={busy || !canBook || !choice || !start || !!stale || (method === "stripe_test" && !cardEnabled)}
            >
              {method === "manual" ? <CalendarCheck aria-hidden="true" /> : <CreditCard aria-hidden="true" />}
              {busy
                ? "Saving…"
                : method === "manual"
                  ? "Hold studio"
                  : "Continue to card payment"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
