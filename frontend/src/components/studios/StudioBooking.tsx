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
  held,
  onClose,
  onBook,
}: {
  size: string | null;
  studios: Studio[];
  today: string;
  cardEnabled: boolean;
  canBook: boolean;
  blockedReason: string;
  busy: boolean;
  error: string;
  held: Rental | null;
  onClose: () => void;
  onBook: (request: BookingRequest) => void;
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
      {held ? (
        <div className="studio-held" role="status">
          <div className="studio-held__head">
            <div>
              <h3>{held.name} is held for you</h3>
              <p>
                {rentalRange(held.starts_on, held.ends_on)} · {money(held.amount_cents)}
              </p>
            </div>
            <BookingReference id={held.id} />
          </div>
          <p className="form-notice">
            <CircleAlert aria-hidden="true" />
            <span>
              Pay at the front desk by{" "}
              <strong>
                {new Date(held.hold_until).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </strong>{" "}
              and give them your booking reference. After that the hold is released.
            </span>
          </p>
          <div className="studio-booking__foot">
            <span>It’s listed under Your rentals until it’s paid.</span>
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
                              ? `Taken until ${calendarDate(addDays(blocked.ends_on, -1), { month: "short", day: "numeric" })}`
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
          {(stale || error) && (
            <p className="form-error" role="alert">
              {stale || error}
            </p>
          )}
          <div className="studio-booking__foot">
            <span>
              {choice?.cancellation_policy === "full_before_start" && start
                ? `Full refund if you cancel before ${calendarDate(start, { month: "short", day: "numeric" })}.`
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
