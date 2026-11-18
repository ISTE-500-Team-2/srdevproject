// Staff queue for studio payments and refund tasks that still require an operator action.

import { useEffect, useRef, useState } from "react";
import { Banknote, CircleAlert, RotateCcw, Undo2 } from "lucide-react";
import { errorMessage } from "../../lib/api";
import { memberName, type DeskTask } from "../../lib/studioDesk";
import { money, rentalRange } from "../../lib/studioDisplay";
import { dayKey } from "../../lib/today";
import { bookingReference } from "./BookingReference";
import { holdTime } from "./OccupancyBoard";

export type Perform = (path: string, body: unknown, done: string) => Promise<void>;

/** Payments, refunds and card retries staff need to record, most urgent first. */
export function DeskQueue({
  tasks,
  timeZone,
  now,
  perform,
}: {
  tasks: DeskTask[];
  timeZone: string;
  now: number;
  perform: Perform;
}) {
  return (
    <section className="desk-panel desk-queue" aria-labelledby="desk-queue-title">
      <div className="desk-panel__head">
        <h2 id="desk-queue-title">Needs you</h2>
        <span className={`desk-count${tasks.length ? " desk-count--hot" : ""}`}>{tasks.length}</span>
        <span className="desk-live">
          <span className="desk-live__dot" aria-hidden="true" />
          Updates as members book and pay
        </span>
      </div>
      {tasks.length ? (
        <ul className="desk-tasks">
          {tasks.map((task) => (
            <DeskTaskRow key={task.rental.id} task={task} timeZone={timeZone} now={now} perform={perform} />
          ))}
        </ul>
      ) : (
        <p className="desk-empty">Nothing waiting. Desk payments and refunds show up here.</p>
      )}
    </section>
  );
}

function DeskTaskRow({
  task: { rental: r, kind },
  timeZone,
  now,
  perform,
}: {
  task: DeskTask;
  timeZone: string;
  now: number;
  perform: Perform;
}) {
  const [reference, setReference] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // On narrow screens the form only appears once opened, and the button that
  // opened it hides; move focus to the receipt box so it isn't lost.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const name = memberName(r);
  // Desk holds last about 30 minutes, so count down in minutes.
  const minutesLeft = Math.ceil((Date.parse(r.hold_until) - now) / 60000);
  const lapsed = kind === "collect" && minutesLeft <= 0;
  const urgent = kind === "collect" && !lapsed && minutesLeft <= 10;
  const deadline = holdTime(r.hold_until, timeZone, dayKey(now, timeZone));
  const failed = r.payment_status === "refund_failed";
  const manualFailed = kind === "refund" && failed;

  const title =
    kind === "collect" ? `Collect from ${name}` : kind === "card" ? `${failed ? "Card refund failed" : "Card refund pending"} for ${name}` : `Refund ${name}`;
  const detail =
    kind === "collect"
      ? lapsed
        ? `Hold ran out at ${deadline}. It can't be paid now.`
        : `Ref ${bookingReference(r.id)} · hold ends ${deadline}${minutesLeft <= 60 ? ` · ${minutesLeft} min left` : ""}`
      : kind === "card"
        ? failed ? "Stripe couldn't complete it" : "Stripe hasn't confirmed it yet"
        : manualFailed ? "Refund failed · check the record" : "Paid at the desk · refund the same way";
  const amount = kind === "collect" ? r.amount_cents : r.refund_cents;
  const action = kind === "collect" ? "Record payment" : "Record refund";

  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    setError("");
    try {
      await perform(path, body, done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`desk-task${urgent ? " desk-task--urgent" : ""}${open ? " desk-task--open" : ""}`}>
      <span className={`desk-task__icon${kind === "card" && failed ? " desk-task__icon--alert" : ""}`} aria-hidden="true">
        {kind === "collect" ? <Banknote /> : kind === "card" ? <CircleAlert /> : <Undo2 />}
      </span>
      <div className="desk-task__who">
        <strong>{title}</strong>
        <span className={(kind === "card" && failed) || lapsed ? "desk-bad" : urgent ? "desk-warn" : undefined}>{detail}</span>
      </div>
      <div className="desk-task__where">
        <strong>{r.name}</strong>
        <span>
          {rentalRange(r.starts_on, r.ends_on)}
          {r.status === "cancelled" ? " · cancelled" : ""}
        </span>
      </div>
      <div className="desk-task__amount">
        {money(amount)}
        <small>{kind === "collect" ? "to collect" : "to refund"}</small>
      </div>
      <div className="desk-task__act">
        {kind === "card" ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            onClick={() => void run(`/studio-management/rentals/${r.id}/retry-refund`, {}, `Refund for ${name} sent to Stripe again.`)}
          >
            <RotateCcw aria-hidden="true" />
            {r.refund_id && failed ? "Recheck refund" : "Retry refund"}
          </button>
        ) : manualFailed || lapsed ? null : (
          <>
            <button
              type="button"
              className={`button desk-task__start${urgent ? " button--primary" : " button--quiet"}`}
              aria-expanded={open}
              aria-controls={`desk-form-${r.id}`}
              onClick={() => setOpen(true)}
            >
              {kind === "collect" ? <Banknote aria-hidden="true" /> : <Undo2 aria-hidden="true" />}
              {action}
            </button>
            <form
              id={`desk-form-${r.id}`}
              className="desk-task__form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  `/studio-management/rentals/${r.id}/${kind === "collect" ? "payment" : "refund"}`,
                  { reference: reference.trim() },
                  kind === "collect" ? `Payment recorded. ${r.name} is booked for ${name}.` : `Refund to ${name} recorded.`,
                );
              }}
            >
              <label className="sr-only" htmlFor={`desk-ref-${r.id}`}>
                {kind === "collect" ? `Receipt or check number for ${name}` : `Refund reference for ${name}`}
              </label>
              <input
                ref={input}
                id={`desk-ref-${r.id}`}
                minLength={3}
                maxLength={200}
                required
                placeholder={kind === "collect" ? "Receipt or check no." : "Refund reference"}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <button className={`button${urgent ? " button--primary" : " button--quiet"}`} disabled={busy}>
                {busy ? "Saving…" : action}
              </button>
            </form>
          </>
        )}
      </div>
      {error ? (
        <p className="desk-task__error form-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
