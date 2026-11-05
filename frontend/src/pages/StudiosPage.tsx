import { useEffect, useMemo, useRef, useState } from "react";
import { BookingReference } from "../components/studios/BookingReference";
import { CancelRentalDialog } from "../components/studios/CancelRentalDialog";
import StatusMark from "../components/reactbits/StatusMark";
import {
  StudioBooking,
  type BookingRequest,
} from "../components/studios/StudioBooking";
import { useAuth } from "../context/AuthContext";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../lib/api";
import type { Rental, Studio } from "../lib/studioContracts";
import {
  bookable,
  calendarDate,
  dateOnly,
  freeFor,
  money,
  nextOpening,
  policy,
  rentalRange,
  SIZE_ORDER,
  sizeKey,
  sizeLabel,
  studioImage,
} from "../lib/studioDisplay";
import "./studios.css";

const ACTIVE = ["pending", "confirmed"];
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** Holds and bookings that still matter; a finished month is history, not something to cancel. */
const current = (r: Rental, today: string) =>
  ACTIVE.includes(r.status) && dateOnly(r.ends_on) > today;

function rentalStatus(r: Rental, today: string) {
  if (r.status === "confirmed" && dateOnly(r.ends_on) <= today)
    return { label: "Ended", tone: "neutral" };
  if (r.status === "confirmed") return { label: "Confirmed", tone: "ok" };
  if (r.status === "pending") return { label: "Awaiting payment", tone: "warn" };
  if (r.status === "expired") return { label: "Hold expired", tone: "neutral" };
  return { label: "Cancelled", tone: "neutral" };
}

function paymentLine(r: Rental) {
  if (r.status === "pending" && r.payment_method === "manual")
    return `Pay at the front desk by ${clock(r.hold_until)} or the hold is released.`;
  if (r.status === "pending")
    return `Card payment not finished. Pay by ${clock(r.hold_until)} or the hold is released.`;
  if (r.status === "expired") return "The hold ran out before payment.";
  if (r.refund_cents > 0) {
    const state =
      r.payment_status === "refunded"
        ? "refunded"
        : r.payment_status === "refund_failed"
          ? "refund failed — staff will follow up"
          : "refund in progress";
    return `${money(r.refund_cents)} ${state} to your original payment method.`;
  }
  if (r.payment_status !== "paid") return "";
  return r.payment_method === "stripe_test" ? "Paid by card." : "Paid at the front desk.";
}

export function StudiosPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [studios, setStudios] = useState<Studio[]>([]),
    [mine, setMine] = useState<Rental[]>([]),
    [card, setCard] = useState(false),
    [zone, setZone] = useState("America/New_York"),
    [loaded, setLoaded] = useState(false);
  const [size, setSize] = useState<string | null>(null),
    [held, setHeld] = useState<Rental | null>(null),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [cancelling, setCancelling] = useState<Rental | null>(null);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // One idempotency key per distinct booking: an identical retry (for example
  // after a lost response) reuses it, while a changed studio, date or payment
  // method gets a fresh key so the server doesn't reject it as KEY_REUSED.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
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
    setLoaded(true);
    setLoadError("");
  }
  // A failed load keeps retrying on the same schedule as live updates, so
  // members never need a refresh button to recover.
  const load = () => refresh().catch((e) => setLoadError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  // Holds, payments and availability change outside this page (front desk,
  // card checkout, other members), so keep it current without a manual
  // refresh while the viewer has something pending or is choosing dates.
  const waiting = mine.some((r) => r.status === "pending");
  const live = waiting || size !== null || (!loaded && !!loadError);
  useEffect(() => {
    if (!live) return;
    const update = () => void load();
    const timer = window.setInterval(update, 15000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [live]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      // Conflicts and price changes mean our copy is stale; show the
      // current availability and rate straight away.
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function book({ studio, startDate, paymentMethod }: BookingRequest) {
    const signature = `${studio.id}|${startDate}|${paymentMethod}`;
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    const requestKey = attempt.current.key;
    await action(async () => {
      const r = await api<Rental & { checkoutUrl?: string }>(
        "/studio-rentals",
        {
          method: "POST",
          body: {
            studioId: studio.id,
            startDate,
            paymentMethod,
            requestKey,
            expectedRevision: studio.revision,
          },
        },
      );
      if (r.checkoutUrl) {
        window.location.assign(r.checkoutUrl);
        return;
      }
      attempt.current = null;
      setHeld({ ...r, name: studio.name });
    });
  }
  const instructor = !!user?.roles.includes("instructor");
  const canBook = user?.membership === "Monthly" && !instructor;
  const blockedReason = instructor
    ? "Instructor accounts can't rent studios."
    : "Studio rentals need an active monthly membership.";
  const groups = useMemo(
    () =>
      SIZE_ORDER.map((key) => {
        const list = studios.filter(
          (s) => sizeKey(s.size) === key && bookable(s),
        );
        const prices = list.map((s) => s.monthly_cents ?? 0);
        return {
          key,
          list,
          price: Math.min(...prices),
          varies: new Set(prices).size > 1,
          freeToday: list.filter((s) => freeFor(s, today)).length,
          opening: nextOpening(list, today),
        };
      }).filter((g) => g.list.length),
    [studios, today],
  );
  const active = mine
    .filter((r) => current(r, today))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const past = mine.filter((r) => !current(r, today));
  const returning = params.get("payment") === "returned";
  // A return URL is not payment evidence. Match this checkout to a rental
  // returned by the authenticated API; never substitute a historical payment.
  const returnedRental = mine.find((r) =>
    String(r.id) === params.get("rental") &&
    !!r.checkout_id && r.checkout_id === params.get("session_id") &&
    r.payment_method === "stripe_test",
  );
  const paidNow =
    returnedRental?.status === "confirmed" && returnedRental.payment_status === "paid" ? returnedRental : null;
  const checkoutLeft = params.get("payment") === "cancelled";
  const unpaidCard = mine.find(
    (r) => r.status === "pending" && r.payment_method === "stripe_test",
  );
  // Back from Stripe with the rental still pending: ask the server to check
  // the checkout once instead of waiting on the webhook alone.
  const synced = useRef(false);
  const syncId = returning && returnedRental?.status === "pending" ? returnedRental.id : null;
  useEffect(() => {
    if (syncId === null || synced.current) return;
    synced.current = true;
    void api(`/studio-rentals/${syncId}/payment-status`, { method: "POST" })
      .then(() => refresh())
      .catch(() => {});
  }, [syncId]);

  function rentalRow(r: Rental) {
    const status = rentalStatus(r, today);
    return (
      <article className="studio-rental" key={r.id}>
        <img src={studioImage(studios.find((s) => s.id === r.studio_id)?.size ?? "")} alt="" />
        <div className="studio-rental__body">
          <h3>{r.name}</h3>
          <p>
            {rentalRange(r.starts_on, r.ends_on)} · {money(r.amount_cents)}
          </p>
          <p className="studio-rental__note">{paymentLine(r)}</p>
        </div>
        <span className={`status-pill status-pill--${status.tone}`}>
          {status.label}
        </span>
        <div className="studio-rental__actions">
          {r.payment_method === "stripe_test" && r.status === "pending" && (
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api<Rental & { checkoutUrl?: string | null }>(
                    `/studio-rentals/${r.id}/payment-status`,
                    { method: "POST" },
                  );
                  if (result.checkoutUrl)
                    window.location.assign(result.checkoutUrl);
                  else if (result.status === "confirmed")
                    setMessage(`Payment received. ${r.name} is booked.`);
                  else if (result.status === "expired")
                    setMessage(`The hold ran out before payment, so ${r.name} was released. Choose a size below to book again.`);
                  else setMessage("Your card payment is still processing. This page updates on its own.");
                })
              }
            >
              Finish card payment
            </button>
          )}
          {current(r, today) && (
            <button
              className="button button--quiet"
              disabled={busy}
              onClick={() => setCancelling(r)}
            >
              Cancel rental
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <section className="studios-page page-enter">
      <h1 className="display-heading">Studio spaces</h1>
      <p className="studios-page__lead">
        Your own workspace for a month at a time. Equipment is booked separately
        by the hour.
      </p>
      {loadError && !loaded && (
        <p className="form-error" role="alert">
          Couldn’t load studios: {loadError} Trying again automatically.
        </p>
      )}
      {!loaded && !loadError && <p role="status">Loading studios…</p>}
      {error && !size && !cancelling && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="studio-message" role="status">{message}</p>}
      {returning && returnedRental?.status === "pending" && (
        <div className="studio-message studio-payment" role="status">
          <StatusMark status="running" size={22} color="#a86008" />
          <span>Checking your card payment. This page updates on its own.</span>
        </div>
      )}
      {returning && paidNow && (
        <div className="studio-message studio-payment" role="status">
          <StatusMark status="done" size={22} doneColor="#1f6b32" />
          <span>
            <b>Payment received.</b> {paidNow.name} is booked.
          </span>
          <BookingReference id={paidNow.id} />
        </div>
      )}
      {checkoutLeft && loaded && (
        <p className="form-notice studio-notice" role="status">
          {unpaidCard
            ? `You left card checkout before paying. ${unpaidCard.name} stays held until ${clock(unpaidCard.hold_until)}. Use Finish card payment below to pay.`
            : "Card checkout was cancelled. Nothing was charged."}
        </p>
      )}
      {returning && loaded && !returnedRental && (
        <p className="studio-message" role="status">
          We couldn’t match this checkout return to a rental. Your current rental and payment statuses are shown below.
        </p>
      )}

      {active.length > 0 && (
        <section className="studio-rentals" aria-labelledby="your-rentals">
          <h2 id="your-rentals">Your rentals</h2>
          {active.map(rentalRow)}
        </section>
      )}

      <div className="studio-grid">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            className="reservation-card studio-size"
            aria-label={`${sizeLabel(g.key)} studios, ${g.varies ? "from " : ""}${money(g.price)} a month. ${availabilityLabel(g)}`}
            onClick={() => {
              setHeld(null);
              setError("");
              setSize(g.key);
            }}
          >
            <div className="reservation-card__image studio-size__image">
              <img src={studioImage(g.key)} alt="" />
              <span
                className={`status-pill status-pill--${g.freeToday ? "ok" : g.opening ? "warn" : "neutral"}`}
              >
                {availabilityLabel(g)}
              </span>
            </div>
            <div className="reservation-card__rule" />
            <div className="reservation-card__title">
              <h2>{sizeLabel(g.key)}</h2>
              <strong>
                {g.varies ? "from " : ""}
                {money(g.price)}/mo
              </strong>
            </div>
            <small>{g.list.map((s) => s.name).join(" · ")}</small>
          </button>
        ))}
      </div>
      {loaded && !groups.length && (
        <p className="empty-state">
          No studios are open for rental right now. New spaces show up here as soon as staff open them.
        </p>
      )}

      {past.length > 0 && (
        <details className="studio-past">
          <summary>Past rentals ({past.length})</summary>
          {past.map(rentalRow)}
        </details>
      )}

      {cancelling && (
        <CancelRentalDialog
          rental={cancelling}
          started={today >= dateOnly(cancelling.starts_on)}
          refundable={
            cancelling.payment_status === "paid" &&
            cancelling.cancellation_policy === "full_before_start" &&
            today < dateOnly(cancelling.starts_on)
              ? cancelling.amount_cents
              : 0
          }
          busy={busy}
          error={error}
          onClose={() => {
            setCancelling(null);
            setError("");
          }}
          onConfirm={() => {
            const r = cancelling;
            void action(async () => {
              await api(`/studio-rentals/${r.id}/cancel`, { method: "POST" });
              setCancelling(null);
              setMessage(`${r.name} cancelled.`);
            });
          }}
        />
      )}

      <StudioBooking
        key={size ?? "closed"}
        size={size}
        studios={groups.find((g) => g.key === size)?.list ?? []}
        today={today}
        cardEnabled={card}
        canBook={canBook}
        blockedReason={blockedReason}
        busy={busy}
        error={size ? error : ""}
        held={held}
        onClose={() => {
          if (busy) return;
          setSize(null);
          setHeld(null);
          setError("");
        }}
        onBook={(request) => void book(request)}
      />

    </section>
  );
}

function availabilityLabel(g: { freeToday: number; list: unknown[]; opening: string | null }) {
  if (g.freeToday) return `${g.freeToday} of ${g.list.length} free today`;
  if (g.opening) return `Next opening ${calendarDate(g.opening, { month: "short", day: "numeric" })}`;
  return "Fully booked";
}
