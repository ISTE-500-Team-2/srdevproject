import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Modal } from "../Modal";
import type { Studio } from "../../lib/studioContracts";
import {
  addDays,
  calendarDate,
  conflictFor,
  freeFor,
  money,
  nextMonth,
  nextOpening,
  rentalRange,
  sizeLabel,
} from "../../lib/studioDisplay";

export type BookingRequest = {
  studio: Studio;
  startDate: string;
  paymentMethod: "manual" | "stripe_test";
};

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function MonthCalendar({
  month,
  setMonth,
  today,
  selected,
  isValid,
  onSelect,
}: {
  month: string;
  setMonth: (month: string) => void;
  today: string;
  selected: string;
  isValid: (date: string) => boolean;
  onSelect: (date: string) => void;
}) {
  const first = month + "-01";
  const lead = new Date(first + "T00:00:00Z").getUTCDay();
  const count = Number(addDays(nextMonth(first), -1).slice(8, 10));
  const shift = (by: number) => {
    const d = new Date(first + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + by);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <div className="studio-cal">
      <div className="studio-cal__head">
        <strong>{calendarDate(first, { month: "long", year: "numeric" })}</strong>
        <span>
          <button
            type="button"
            className="icon-button"
            aria-label="Previous month"
            disabled={month <= today.slice(0, 7)}
            onClick={() => shift(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next month"
            onClick={() => shift(1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="studio-cal__grid" role="group" aria-label="Start date">
        {WEEKDAYS.map((d) => (
          <span key={d} className="studio-cal__dow" aria-hidden="true">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={"lead" + i} />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const valid = date >= today && isValid(date);
          return (
            <button
              key={date}
              type="button"
              className="studio-cal__day"
              aria-label={calendarDate(date)}
              aria-pressed={date === selected}
              disabled={!valid}
              onClick={() => onSelect(date)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
  held: { name: string; holdUntil: string } | null;
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
          <h3>{held.name} is held for you</h3>
          <p>
            Pay at the front desk by{" "}
            <strong>
              {new Date(held.holdUntil).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </strong>{" "}
            to confirm it. After that the hold is released.
          </p>
          <button type="button" className="button button--primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <form
          className="studio-booking"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice && start)
              onBook({ studio: choice, startDate: start, paymentMethod: method });
          }}
        >
          {!canBook && (
            <p className="studio-booking__gate">
              {blockedReason}{" "}
              <Link to="/membership">See membership options</Link>
            </p>
          )}
          <div className="studio-booking__cols">
            <fieldset>
              <legend>
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
                  : "Rentals run one calendar month. Crossed-out days have no studio free for a full month."}
              </p>
            </fieldset>
            <div>
              <fieldset>
                <legend>
                  <span>2</span>Studio
                </legend>
                <div className="studio-options">
                  {studios.map((s) => {
                    const blocked = start ? conflictFor(s, start, end) : undefined;
                    return (
                      <label
                        key={s.id}
                        className={"studio-option" + (blocked ? " is-unavailable" : "")}
                      >
                        <input
                          type="radio"
                          name="studio"
                          checked={studioId === s.id}
                          disabled={!start || !!blocked}
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
                <legend>
                  <span>3</span>Payment
                </legend>
                <div className="studio-options">
                  <label className="studio-option">
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
                  {cardEnabled && (
                    <label className="studio-option">
                      <input
                        type="radio"
                        name="payment"
                        checked={method === "stripe_test"}
                        onChange={() => setMethod("stripe_test")}
                      />
                      <span>
                        <strong>Pay now by card</strong>
                        <small>Test mode — no real charge.</small>
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
          {error && (
            <p className="form-error" role="alert">
              {error}
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
              disabled={busy || !canBook || !choice || !start}
            >
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
