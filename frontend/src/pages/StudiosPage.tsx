import { useEffect,useState } from "react";
import { AvailabilityCalendar } from "../components/studios/AvailabilityCalendar";
import { StaffRental } from "../components/studios/StaffRental";
import { StudioConfig } from "../components/studios/StudioConfig";
import { useAuth } from "../context/AuthContext";
import { api,errorMessage } from "../lib/api";
import type { Rental,Studio } from '../lib/studioContracts';
import { dateOnly,money,nextMonth,policy } from '../lib/studioDisplay';
import "./studios.css";

export function StudiosPage() {
  const { user } = useAuth();
  const staff = !!user?.roles.some((r) =>
    ["admin", "staff", "super-admin"].includes(r),
  );
  const admin = !!user?.roles.some((r) => ["admin", "super-admin"].includes(r));
  const [studios, setStudios] = useState<Studio[]>([]),
    [mine, setMine] = useState<Rental[]>([]),
    [management, setManagement] = useState<Rental[]>([]),
    [card, setCard] = useState(false),
    [zone, setZone] = useState("America/New_York");
  const [start, setStart] = useState(""),
    [method, setMethod] = useState("manual"),
    [requestKey, setRequestKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const end = nextMonth(start);
  async function refresh() {
    const [data, rentals] = await Promise.all([
      api<{ studios: Studio[]; cardTestEnabled: boolean; timeZone: string }>(
        "/studios",
      ),
      api<Rental[]>("/studio-rentals"),
    ]);
    setStudios(data.studios);
    setCard(data.cardTestEnabled);
    setZone(data.timeZone);
    setMine(rentals);
    if (staff) setManagement(await api<Rental[]>("/studio-management/rentals"));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, [staff]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function book(s: Studio) {
    await action(async () => {
      const r = await api<Rental & { checkoutUrl?: string }>(
        "/studio-rentals",
        {
          method: "POST",
          body: {
            studioId: s.id,
            startDate: start,
            paymentMethod: method,
            requestKey,
            expectedRevision: s.revision,
          },
        },
      );
      if (r.checkoutUrl) {
        window.location.assign(r.checkoutUrl);
        return;
      }
      setRequestKey(crypto.randomUUID());
      setMessage(
        `Studio held until ${new Date(r.hold_until).toLocaleTimeString()}. Pay with staff before then; your booking is not confirmed yet.`,
      );
    });
  }
  const canBook =
    user?.membership === "Monthly" && !user?.roles.includes("instructor");
  return (
    <section className="studios-page">
      <h1>Monthly studio rentals</h1>
      <p>
        Choose your own workspace for one month. Equipment reservations are
        separate.
      </p>
      <p className="studio-note">
        Dates use {zone}. Your rental ends on the same day next month, or that
        month’s last day if needed. This date rule is provisional pending studio
        approval.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {new URLSearchParams(window.location.search).has("payment") && (
        <p role="status">
          Returning from checkout does not confirm payment. Refresh below to see
          the verified payment status.
        </p>
      )}
      <button
        className="button button--secondary"
        disabled={busy}
        onClick={() => void action(async () => {})}
      >
        Refresh availability and payment status
      </button>
      <div className="studio-controls">
        <label>
          Rental start date
          <input
            type="date"
            min={today}
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setRequestKey(crypto.randomUUID());
            }}
          />
        </label>
        <label>
          Payment method
          <select
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setRequestKey(crypto.randomUUID());
            }}
          >
            <option value="manual">Pay with staff</option>
            {card && (
              <option value="stripe_test">
                Card checkout — TEST MODE, no real charges
              </option>
            )}
          </select>
        </label>
      </div>
      {end && (
        <p>
          Rental period:{" "}
          <strong>
            {start} through {end}
          </strong>{" "}
          (end date exclusive).
        </p>
      )}
      {!canBook && (
        <p>
          An active monthly subscription is required. Instructor accounts cannot
          create reservations.
        </p>
      )}
      <h2>All-studio availability</h2>
      <p>
        Select a start date to compare all spaces for the entire month. Existing
        holds count as unavailable until released.
      </p>
      <AvailabilityCalendar
        studios={studios}
        selectedStart={start}
        onSelect={(value) => {
          setStart(value);
          setRequestKey(crypto.randomUUID());
        }}
      />
      <div className="studio-grid">
        {studios.map((s) => {
          const conflict = s.availability.some(
            (r) => dateOnly(r.starts_on) < end && dateOnly(r.ends_on) > start,
          );
          return (
            <article className="studio-card" key={s.id}>
              <h3>{s.name}</h3>
              <p>
                {s.size} ·{" "}
                {s.monthly_cents
                  ? money(s.monthly_cents) + " / month"
                  : "Rate pending"}
              </p>
              <p>{policy(s.cancellation_policy)}</p>
              <strong>
                {!start
                  ? "Select dates"
                  : conflict
                    ? "Unavailable for selected month"
                    : "Available for selected month"}
              </strong>
              <ul aria-label={`${s.name} occupied dates`}>
                {s.availability.map((r, i) => (
                  <li key={i}>
                    {dateOnly(r.starts_on)} – {dateOnly(r.ends_on)} ·{" "}
                    {r.status === "pending" ? "Checkout hold" : "Booked"}
                  </li>
                ))}
              </ul>
              <button
                className="button"
                disabled={
                  busy ||
                  !canBook ||
                  !start ||
                  conflict ||
                  !s.policy_confirmed ||
                  !s.monthly_cents
                }
                onClick={() => void book(s)}
              >
                {method === "manual"
                  ? "Hold and pay with staff"
                  : "Continue to test card checkout"}
              </button>
              {admin && (
                <StudioConfig
                  studio={s}
                  busy={busy}
                  save={(body) =>
                    action(async () => {
                      await api(`/studio-management/studios/${s.id}`, {
                        method: "PATCH",
                        body,
                      });
                      setMessage(
                        "Studio rate and policy saved. Existing rentals keep their agreed terms.",
                      );
                    })
                  }
                />
              )}
            </article>
          );
        })}
      </div>
      <h2>Your rentals</h2>
      {!mine.length && <p>No studio rentals yet.</p>}
      {mine.map((r) => (
        <article className="studio-card" key={r.id}>
          <h3>{r.name}</h3>
          <p>
            {dateOnly(r.starts_on)} – {dateOnly(r.ends_on)} ·{" "}
            {money(r.amount_cents)}
          </p>
          <p>
            Booking: <strong>{r.status}</strong> · Payment:{" "}
            <strong>{r.payment_status.replaceAll("_", " ")}</strong> (
            {r.payment_method === "stripe_test" ? "test card" : "staff payment"}
            )
          </p>
          <p>{policy(r.cancellation_policy)}</p>
          {r.refund_cents > 0 && (
            <p>
              Refund: {money(r.refund_cents)} to the original payment method ·{" "}
              {r.payment_status.replaceAll("_", " ")}
            </p>
          )}
          {r.payment_method === "stripe_test" && r.status === "pending" && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api<{ checkoutUrl?: string }>(
                    `/studio-rentals/${r.id}/payment-status`,
                    { method: "POST" },
                  );
                  if (result.checkoutUrl)
                    window.location.assign(result.checkoutUrl);
                  else setMessage("Payment status reconciled.");
                })
              }
            >
              Resume / verify test checkout
            </button>
          )}
          {["pending", "confirmed"].includes(r.status) && (
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => {
                const refundable =
                  r.payment_status === "paid" &&
                  r.cancellation_policy === "full_before_start" &&
                  today < dateOnly(r.starts_on)
                    ? r.amount_cents
                    : 0;
                if (
                  window.confirm(
                    `Cancel this rental? Expected refund: ${money(refundable)} to the original payment method. ${policy(r.cancellation_policy)}`,
                  )
                )
                  void action(async () => {
                    await api(`/studio-rentals/${r.id}/cancel`, {
                      method: "POST",
                    });
                    setMessage(
                      "Rental cancelled. Check its refund status below.",
                    );
                  });
              }}
            >
              Cancel rental
            </button>
          )}
        </article>
      ))}
      {staff && (
        <>
          <h2>Staff payment desk</h2>
          <p>
            Record only payments already received. Never enter full card
            numbers. Manual refunds must be returned using the original payment
            method before marking complete.
          </p>
          {management.map((r) => (
            <StaffRental
              key={r.id}
              rental={r}
              busy={busy}
              perform={(path, body) =>
                action(async () => {
                  await api(path, { method: "POST", body });
                  setMessage("Payment record updated.");
                })
              }
            />
          ))}
        </>
      )}
    </section>
  );
}
