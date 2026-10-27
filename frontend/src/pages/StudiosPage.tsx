import { useEffect, useMemo, useRef, useState } from "react";
import { BookingReference } from "../components/studios/BookingReference";
import StatusMark from "../components/reactbits/StatusMark";
import {
  StudioBooking,
  type BookingRequest,
} from "../components/studios/StudioBooking";
import { useAuth } from "../context/AuthContext";
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

function rentalStatus(r: Rental) {
  if (r.status === "confirmed") return { label: "Confirmed", tone: "ok" };
  if (r.status === "pending") return { label: "Awaiting payment", tone: "warn" };
  if (r.status === "expired") return { label: "Hold expired", tone: "neutral" };
  return { label: "Cancelled", tone: "neutral" };
}

function paymentLine(r: Rental) {
  const how = r.payment_method === "stripe_test" ? "card" : "front desk";
  if (r.status === "pending" && r.payment_method === "manual")
    return `Pay at the front desk by ${new Date(r.hold_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  if (r.status === "pending") return "Card payment not finished yet.";
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
  return r.payment_status === "paid" ? `Paid at the ${how}.` : "";
}

export function StudiosPage() {
  const { user } = useAuth();
  const [studios, setStudios] = useState<Studio[]>([]),
    [mine, setMine] = useState<Rental[]>([]),
    [card, setCard] = useState(false),
    [zone, setZone] = useState("America/New_York"),
    [loaded, setLoaded] = useState(false);
  const [size, setSize] = useState<string | null>(null),
    [held, setHeld] = useState<{ name: string; holdUntil: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
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
  }
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, []);
  // Holds, payments and availability change outside this page (front desk,
  // card checkout, other members), so keep it current without a manual
  // refresh while the viewer has something pending or is choosing dates.
  const waiting = mine.some((r) => r.status === "pending");
  const live = waiting || size !== null;
  useEffect(() => {
    if (!live) return;
    const update = () => void refresh().catch(() => {});
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
      setHeld({ name: studio.name, holdUntil: r.hold_until });
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
  const active = mine.filter((r) => ACTIVE.includes(r.status));
  const past = mine.filter((r) => !ACTIVE.includes(r.status));
  const returning =
    new URLSearchParams(window.location.search).get("payment") === "returned";
  // Only server records count as proof of payment: the newest rental, once
  // it is confirmed and paid, is the one this checkout was for.
  const newest = mine.reduce<Rental | null>((a, r) => (!a || r.id > a.id ? r : a), null);
  const paidNow =
    newest?.status === "confirmed" && newest.payment_status === "paid" ? newest : null;

  function rentalRow(r: Rental) {
    const status = rentalStatus(r);
    return (
      <article className="studio-rental" key={r.id}>
        <img src={studioImage(studios.find((s) => s.name === r.name)?.size ?? "")} alt="" />
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
                  const result = await api<{ checkoutUrl?: string }>(
                    `/studio-rentals/${r.id}/payment-status`,
                    { method: "POST" },
                  );
                  if (result.checkoutUrl)
                    window.location.assign(result.checkoutUrl);
                  else setMessage("Payment status updated.");
                })
              }
            >
              Finish card payment
            </button>
          )}
          {ACTIVE.includes(r.status) && (
            <button
              className="button button--quiet"
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
                    `Cancel ${r.name}? You'll get ${money(refundable)} back to your original payment method. ${policy(r.cancellation_policy)}`,
                  )
                )
                  void action(async () => {
                    await api(`/studio-rentals/${r.id}/cancel`, {
                      method: "POST",
                    });
                    setMessage(`${r.name} cancelled.`);
                  });
              }}
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
      {error && !size && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="studio-message" role="status">{message}</p>}
      {returning && waiting && (
        <div className="studio-message studio-payment" role="status">
          <StatusMark status="running" size={22} color="#a86008" />
          <span>Checking your card payment. This page updates on its own.</span>
        </div>
      )}
      {returning && !waiting && paidNow && (
        <div className="studio-message studio-payment" role="status">
          <StatusMark status="done" size={22} doneColor="#1f6b32" />
          <span>
            <b>Payment received.</b> {paidNow.name} is booked.
          </span>
          <BookingReference id={paidNow.id} />
        </div>
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
            aria-label={`${sizeLabel(g.key)} studios, ${g.varies ? "from " : ""}${money(g.price)} a month`}
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
                {g.freeToday
                  ? `${g.freeToday} of ${g.list.length} free today`
                  : g.opening
                    ? `Next opening ${calendarDate(g.opening, { month: "short", day: "numeric" })}`
                    : "Fully booked"}
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
        <p className="empty-state">No studios are open for rental right now.</p>
      )}

      {past.length > 0 && (
        <details className="studio-past">
          <summary>Past rentals ({past.length})</summary>
          {past.map(rentalRow)}
        </details>
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
          setSize(null);
          setHeld(null);
          setError("");
        }}
        onBook={(request) => void book(request)}
      />

    </section>
  );
}
