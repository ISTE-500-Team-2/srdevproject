import { useState } from "react";
import { Banknote, CircleAlert, RotateCcw, Undo2 } from "lucide-react";
import { errorMessage } from "../../lib/api";
import { memberName, type DeskTask } from "../../lib/studioDesk";
import { money, rentalRange } from "../../lib/studioDisplay";

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
  const name = memberName(r);
  const holdEnds = Date.parse(r.hold_until);
  const urgent = kind === "collect" && holdEnds - now < 2 * 864e5;
  const deadline = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).format(holdEnds);
  const failed = r.payment_status === "refund_failed";
  const manualFailed = kind === "refund" && failed;

  const title =
    kind === "collect" ? `Collect from ${name}` : kind === "card" ? `${failed ? "Card refund failed" : "Card refund pending"} for ${name}` : `Refund ${name}`;
  const detail =
    kind === "collect"
      ? `Pay at desk · hold ends ${deadline}`
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
        <span className={kind === "card" && failed ? "desk-bad" : urgent ? "desk-warn" : undefined}>{detail}</span>
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
        ) : manualFailed ? null : (
          <>
            <button type="button" className={`button desk-task__start${urgent ? " button--primary" : " button--quiet"}`} onClick={() => setOpen(true)}>
              {kind === "collect" ? <Banknote aria-hidden="true" /> : <Undo2 aria-hidden="true" />}
              {action}
            </button>
            <form
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
                id={`desk-ref-${r.id}`}
                minLength={3}
                maxLength={200}
                required
                autoFocus={open}
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
