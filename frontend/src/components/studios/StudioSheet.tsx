import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarCheck, CircleAlert, Eye, Mail, Pencil } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { errorMessage } from "../../lib/api";
import type { Rental, Studio } from "../../lib/studioContracts";
import { daysBetween, memberName, rentalFor, studioNow } from "../../lib/studioDesk";
import {
  addDays,
  bookable,
  calendarDate,
  dateOnly,
  money,
  rentalRange,
  sizeLabel,
  studioImage,
} from "../../lib/studioDisplay";
import { initials, tone } from "../../lib/today";
import { Modal } from "../Modal";
import { holdDate } from "./OccupancyBoard";

const policies = [
  { key: "no_refunds", label: "No refunds", detail: "Cancelling frees the studio. Nothing is refunded." },
  { key: "full_before_start", label: "Full refund before start", detail: "No refund on or after the start date." },
];
const policyShort = (p: string | null) => policies.find((x) => x.key === p)?.label ?? "Not set";
const stateLabel = { rented: "Rented", held: "Held for payment", open: "Open", off: "Not offered" };
const short = (d: string) => calendarDate(d, { month: "short", day: "numeric" });

/** Side sheet for one studio: who has it, what's next, its rate and terms, and past renters. */
export function StudioSheet({
  studio: s,
  rentals,
  today,
  timeZone,
  canEdit,
  onClose,
  save,
}: {
  studio: Studio;
  rentals: Rental[];
  today: string;
  timeZone: string;
  canEdit: boolean;
  onClose: () => void;
  save: (body: unknown) => Promise<void>;
}) {
  const { state, current, freeFrom } = studioNow(s, today);
  const renter = current ? rentalFor(s, current, rentals) : undefined;
  const upcoming = s.availability
    .filter((r) => dateOnly(r.starts_on) > today)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const past = rentals
    .filter((r) => r.studio_id === s.id && r.status === "confirmed" && dateOnly(r.ends_on) <= today)
    .sort((a, b) => b.ends_on.localeCompare(a.ends_on))
    .slice(0, 3);

  return (
    <Modal open title={s.name} width="panel" onClose={onClose}>
      <div className="studio-sheet">
        <div className="studio-sheet__hero">
          <img src={studioImage(s.size)} alt="" />
          <p>
            {sizeLabel(s.size)} studio
            <span className={`desk-pill desk-pill--${state}`}>{stateLabel[state]}</span>
          </p>
        </div>

        <section className="studio-sheet__section" aria-labelledby="sheet-now">
          <h3 id="sheet-now">{state === "held" ? "Held now" : "Renting now"}</h3>
          {current ? (
            <Renter rental={renter} slot={current} today={today} timeZone={timeZone} />
          ) : (
            <p className="studio-sheet__muted">Nobody has it right now.</p>
          )}
        </section>

        <section className="studio-sheet__section" aria-labelledby="sheet-next">
          <h3 id="sheet-next">Next</h3>
          {upcoming.map((slot) => (
            <p key={slot.starts_on} className="studio-sheet__next">
              <strong>{memberName(rentalFor(s, slot, rentals))}</strong>
              <span>
                {rentalRange(slot.starts_on, slot.ends_on)} ·{" "}
                {slot.status === "pending" ? `held, pay by ${holdDate(slot.hold_until, timeZone)}` : "booked"}
              </span>
            </p>
          ))}
          <p className="studio-sheet__free">
            <CalendarCheck aria-hidden="true" />
            {state === "off"
              ? "Members can't book it until it has a rate and terms."
              : freeFrom === today
                ? upcoming.length ? `Open now until ${short(addDays(dateOnly(upcoming[0].starts_on), -1))}.` : "Open now. Nothing booked."
                : `Open from ${calendarDate(freeFrom, { weekday: "short", month: "short", day: "numeric" })}.`}
          </p>
        </section>

        <StudioTerms
          key={s.revision}
          studio={s}
          canEdit={canEdit}
          kept={(current ? 1 : 0) + upcoming.length}
          save={save}
        />

        {past.length ? (
          <section className="studio-sheet__section" aria-labelledby="sheet-past">
            <h3 id="sheet-past">Past rentals</h3>
            <ul className="studio-sheet__past">
              {past.map((r) => (
                <li key={r.id}>
                  <span className={`desk-avatar desk-avatar--${tone(r.userid ?? r.id)}`} aria-hidden="true">
                    {initials(memberName(r))}
                  </span>
                  <strong>{memberName(r)}</strong>
                  <span>{rentalRange(r.starts_on, r.ends_on)}</span>
                  <span className="studio-sheet__amount">{money(r.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function Renter({
  rental,
  slot,
  today,
  timeZone,
}: {
  rental?: Rental;
  slot: Studio["availability"][number];
  today: string;
  timeZone: string;
}) {
  const { openAccount } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = memberName(rental);
  const left = daysBetween(today, slot.ends_on);
  const paid = rental?.payment_status === "paid";
  return (
    <>
      <div className="studio-sheet__renter">
        <span className={`desk-avatar desk-avatar--${tone(rental?.userid ?? 0)}`} aria-hidden="true">
          {initials(name)}
        </span>
        <div>
          <strong>{name}</strong>
          {rental?.email ? <span>{rental.email}</span> : null}
        </div>
        <div className="studio-sheet__when">
          {rentalRange(slot.starts_on, slot.ends_on)}
          <small>{slot.status === "pending" ? `Hold ends ${holdDate(slot.hold_until, timeZone)}` : `${left} ${left === 1 ? "day" : "days"} left`}</small>
        </div>
      </div>
      {rental ? (
        <dl className="studio-sheet__facts">
          <div>
            <dt>Paid</dt>
            <dd>{paid ? `${money(rental.amount_cents)} · ${rental.payment_method === "manual" ? "at desk" : "card"}` : "Not yet"}</dd>
          </div>
          <div>
            <dt>Refunds</dt>
            <dd>{policyShort(rental.cancellation_policy)}</dd>
          </div>
        </dl>
      ) : null}
      <div className="studio-sheet__actions">
        {rental?.userid ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await openAccount(rental.userid!);
                navigate("/studios");
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            <Eye aria-hidden="true" />
            Open account
          </button>
        ) : null}
        {rental?.email ? (
          <a className="button button--quiet" href={`mailto:${rental.email}`}>
            <Mail aria-hidden="true" />
            Email
          </a>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function StudioTerms({
  studio: s,
  canEdit,
  kept,
  save,
}: {
  studio: Studio;
  canEdit: boolean;
  kept: number;
  save: (body: unknown) => Promise<void>;
}) {
  const offered = bookable(s);
  const [editing, setEditing] = useState(canEdit && !offered);
  const [rate, setRate] = useState(s.monthly_cents ? (s.monthly_cents / 100).toFixed(2) : "");
  const [policy, setPolicy] = useState(s.cancellation_policy ?? "no_refunds");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cents = Math.round(Number(rate) * 100);
  const changed = cents !== s.monthly_cents || policy !== s.cancellation_policy || !offered;

  function reset() {
    setRate(s.monthly_cents ? (s.monthly_cents / 100).toFixed(2) : "");
    setPolicy(s.cancellation_policy ?? "no_refunds");
    setConfirmed(false);
    setError("");
    setEditing(false);
  }

  return (
    <section className="studio-sheet__section" aria-labelledby="sheet-terms">
      <h3 id="sheet-terms">
        Rate and terms
        {canEdit && !editing ? (
          <button type="button" className="button button--quiet desk-small" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" />
            Edit
          </button>
        ) : null}
      </h3>
      {!editing ? (
        <>
          <p className="studio-sheet__rate">
            <strong>{s.monthly_cents ? money(s.monthly_cents) : "No rate"}</strong>
            {s.monthly_cents ? <span>/ month</span> : null}
          </p>
          <p className="studio-sheet__muted">
            {offered
              ? `${policyShort(s.cancellation_policy)}. ${policies.find((p) => p.key === s.cancellation_policy)?.detail ?? ""}`
              : "Not offered to members yet."}
          </p>
        </>
      ) : (
        <form
          className="studio-terms"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await save({ monthlyCents: cents, cancellationPolicy: policy, policyConfirmed: confirmed, revision: s.revision });
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          <label className="studio-terms__label" htmlFor={`rate-${s.id}`}>
            Monthly rate
          </label>
          <div className="studio-terms__money">
            <span aria-hidden="true">$</span>
            <input
              id={`rate-${s.id}`}
              type="number"
              inputMode="decimal"
              min="0.50"
              max="100000"
              step="0.01"
              required
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
            <span aria-hidden="true">/ month</span>
          </div>
          {s.monthly_cents && cents !== s.monthly_cents ? (
            <p className="studio-terms__was">Currently {money(s.monthly_cents)}</p>
          ) : null}
          <fieldset className="studio-terms__policies">
            <legend className="studio-terms__label">If a member cancels</legend>
            {policies.map((p) => (
              <label key={p.key} className="studio-terms__policy">
                <input type="radio" name={`policy-${s.id}`} value={p.key} checked={policy === p.key} onChange={() => setPolicy(p.key)} />
                <span>
                  <strong>{p.label}</strong>
                  <span>{p.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {changed ? (
            <>
              <p className="studio-terms__impact">
                <CircleAlert aria-hidden="true" />
                <span>
                  {!offered
                    ? `Saving offers ${s.name} to members at this rate.`
                    : `New bookings pay ${Number.isFinite(cents) && cents > 0 ? money(cents) : "the new rate"}.`}
                  {kept ? ` ${kept === 1 ? "The current rental keeps" : `The ${kept} current and upcoming rentals keep`} the price and terms ${kept === 1 ? "it was" : "they were"} booked with.` : ""}
                </span>
              </p>
              <label className="studio-terms__confirm">
                <input type="checkbox" checked={confirmed} required onChange={(e) => setConfirmed(e.target.checked)} />
                The Collaboratory approved this rate and these terms.
              </label>
            </>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="studio-sheet__actions">
            <button className="button button--primary" disabled={busy || !changed || !confirmed}>
              {busy ? "Saving…" : "Save rate and terms"}
            </button>
            {offered ? (
              <button type="button" className="button button--quiet" onClick={reset}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
