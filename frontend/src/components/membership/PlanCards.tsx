import { useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Clock, Lock } from "lucide-react";
import type { Billing, Offer } from "../../lib/billingContracts";
import type { Entitlement, Plan } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { cents, dollars, shortDate } from "../../lib/display";
import { lastCancelDay } from "./dates";
import { errorMessage } from "../../lib/api";
import { LoadState } from "../Management";
import { Modal } from "../Modal";
import { StatusPill } from "./StatusPill";

type Post = (path: string, body: unknown) => Promise<unknown>;

const rateNames: Record<string, string> = {
  student: "Student rate",
  school_partner: "School partner rate",
};

/** Online card checkout only supports monthly plans the provider will accept. */
export function canCheckout(o: Offer) {
  return o.kind === "membership" && o.months === 1 && o.amountCents >= 50 && o.amountCents <= 10000000;
}

interface Props {
  plans: Plan[];
  billingEnabled: boolean;
  billing: Billing[];
  memberships: Entitlement[];
  today: string;
  busy: boolean;
  post: Post;
  run: (path: string, body: unknown, done: (result: Record<string, unknown>) => string) => void;
}

export function PlanCards({ plans, billingEnabled, billing, memberships, today, busy, post, run }: Props) {
  const [date, setDate] = useState("");
  const offers = useApi<Offer[]>(
    billingEnabled
      ? "/me/billing/offers" + (date ? "?date=" + encodeURIComponent(date) : "")
      : null,
    { retainOnReload: true },
  );
  // Changing the visit date re-quotes prices; keep the last quote on screen
  // meanwhile so the cards don't flicker back to list prices.
  const lastOffers = useRef<Offer[] | null>(null);
  if (offers.data) lastOffers.current = offers.data;
  const quoting = offers.loading || offers.refreshing;
  const [confirming, setConfirming] = useState<Offer | null>(null);
  const offerFor = (id: number) => lastOffers.current?.find((o) => o.id === id);
  const held = memberships.filter((m) => ["active", "scheduled"].includes(m.effectiveStatus));
  const pending = billing.find((r) => r.status === "pending");
  const hasMembership = held.length > 0 || billing.some((r) => r.status !== "pending");
  const visible = plans.filter((p) => p.active);
  const membershipPlans = visible.filter((p) => p.kind === "membership");
  const dayPasses = visible.filter((p) => p.kind === "day_pass");

  return (
    <section className="membership-offers" aria-labelledby="get-access-heading">
      <div className="membership-section-heading">
        <h2 id="get-access-heading">Get access</h2>
        <p>
          {billingEnabled
            ? "Pay by card here, or at the front desk."
            : "Sign up or buy a pass at the front desk."}
        </p>
        {billingEnabled ? (
          <p className="membership-test-note">
            Payments are in test mode, so you won't be charged. Use card
            4242 4242 4242 4242 with any future expiry date.
          </p>
        ) : null}
      </div>
      <LoadState {...offers} loading={offers.loading && !lastOffers.current} />
      <div className="plan-cards">
        {membershipPlans.map((plan) => {
          const offer = offerFor(plan.id);
          const yours = held.some((m) => m.planId === plan.id);
          let action;
          if (yours)
            action = (
              <button className="button button--quiet button--wide" disabled>
                You're on this plan
              </button>
            );
          else if (pending && offer && pending.plan.id === plan.id && canCheckout(offer))
            action = (
              <button
                className="button button--primary button--wide"
                disabled={busy}
                onClick={() => setConfirming(offer)}
              >
                Finish checkout
                <ArrowRight aria-hidden="true" />
              </button>
            );
          else if (hasMembership || pending)
            action = <p className="membership-hint">You already have a membership.</p>;
          else if (offer && offer.amountCents === 0)
            action = (
              <button
                className="button button--primary button--wide"
                disabled={busy}
                onClick={() => setConfirming(offer)}
              >
                Claim free month
              </button>
            );
          else if (offer && canCheckout(offer))
            action = (
              <button
                className="button button--primary button--wide"
                disabled={busy}
                onClick={() => setConfirming(offer)}
              >
                Start membership
                <ArrowRight aria-hidden="true" />
              </button>
            );
          else
            action = (
              <p className="membership-hint">Ask at the front desk to sign up for this plan.</p>
            );
          return (
            <PlanCard key={plan.id} plan={plan} offer={offer} current={yours}>
              {action}
            </PlanCard>
          );
        })}
        {dayPasses.map((plan) => {
          const offer = offerFor(plan.id);
          const deadline = date ? lastCancelDay(date) : null;
          return (
            <PlanCard key={plan.id} plan={plan} offer={offer}>
              {billingEnabled && offer ? (
                <>
                  <label className="membership-field">
                    Visit date
                    <input
                      type="date"
                      min={today}
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                  {deadline ? (
                    <p className="membership-hint">
                      <Clock aria-hidden="true" />
                      Free cancellation through {deadline}
                    </p>
                  ) : null}
                  <button
                    className="button button--primary button--wide"
                    disabled={busy || !date || quoting}
                    onClick={() =>
                      run(
                        "/me/billing/passes/checkout",
                        {
                          planId: offer.id,
                          expectedRevision: offer.revision,
                          pricingRevision: offer.pricingRevision,
                          amountCents: offer.amountCents,
                          validDate: date,
                        },
                        () => `Your day pass for ${shortDate(date)} is booked.`,
                      )
                    }
                  >
                    {!date
                      ? "Choose a date"
                      : offer.amountCents === 0
                        ? "Claim free day pass"
                        : `Buy day pass · ${cents(offer.amountCents)}`}
                  </button>
                </>
              ) : (
                <p className="membership-hint">Buy a day pass at the front desk.</p>
              )}
            </PlanCard>
          );
        })}
        {!visible.length ? <p>No plans are available right now.</p> : null}
      </div>

      <ConfirmMembership
        offer={confirming}
        busy={busy}
        post={post}
        onClose={() => setConfirming(null)}
      />
    </section>
  );
}

function PlanCard({
  plan,
  offer,
  current = false,
  children,
}: {
  plan: Plan;
  offer?: Offer;
  current?: boolean;
  children: ReactNode;
}) {
  const discounted = offer && offer.basis !== "standard";
  const benefits = plan.benefits
    .split(/\r?\n/)
    .map((b) => b.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  const period =
    plan.kind === "day_pass" ? "day" : plan.months === 1 ? "month" : `${plan.months} months`;
  return (
    <article className={`plan-card${current ? " plan-card--current" : ""}`}>
      <div className="plan-card__heading">
        <h3>{plan.name}</h3>
        {current ? <StatusPill tone="neutral">Your plan</StatusPill> : null}
        {discounted && !current ? (
          <StatusPill tone="ok">{rateNames[offer.basis] ?? "Discounted rate"}</StatusPill>
        ) : null}
      </div>
      <p className="plan-card__price">
        {offer ? cents(offer.amountCents) : dollars(plan.price)}
        <small> / {period}</small>
        {discounted ? <s>{dollars(plan.price)}</s> : null}
      </p>
      {benefits.length ? (
        <ul className="plan-card__benefits">
          {benefits.map((b) => (
            <li key={b}>
              <Check aria-hidden="true" />
              {b}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="plan-card__action">{children}</div>
    </article>
  );
}

function ConfirmMembership({
  offer,
  busy,
  post,
  onClose,
}: {
  offer: Offer | null;
  busy: boolean;
  post: Post;
  onClose: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const free = offer?.amountCents === 0;
  function close() {
    setConsent(false);
    setError("");
    onClose();
  }
  async function submit() {
    if (!offer) return;
    setError("");
    try {
      if (free)
        await post("/me/billing/free-membership", {
          planId: offer.id,
          expectedRevision: offer.revision,
          pricingRevision: offer.pricingRevision,
        });
      else
        await post("/me/billing/checkout", {
          planId: offer.id,
          expectedRevision: offer.revision,
          autoRenewConsent: true,
          pricingRevision: offer.pricingRevision,
          amountCents: offer.amountCents,
        });
      close();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const price = offer ? cents(offer.amountCents) : "";
  return (
    <Modal
      open={!!offer}
      title={free ? "Claim free month" : "Start membership"}
      width="compact"
      onClose={close}
    >
      {offer ? (
        <>
          <dl className="membership-summary">
            <div>
              <dt>Plan</dt>
              <dd>{offer.name}</dd>
            </div>
            <div>
              <dt>Starts</dt>
              <dd>{free ? "Today" : "Once your payment clears"}</dd>
            </div>
            <div>
              <dt>Renews</dt>
              <dd>{free ? "Doesn't renew" : "Every month until you cancel"}</dd>
            </div>
            <div className="membership-summary__total">
              <dt>Due today</dt>
              <dd>{price}</dd>
            </div>
          </dl>
          {free ? (
            <p>You get one month of access for free. It ends on its own and you won't be charged.</p>
          ) : (
            <>
              <label className="membership-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Charge my card {price} every month until I cancel. If I
                  cancel, it takes effect on the first billing date that's at
                  least 30 days after I ask.
                </span>
              </label>
              <details className="membership-terms">
                <summary>Cancellation terms</summary>
                <p>
                  Your membership renews automatically each month at {price}.
                  To cancel, turn off auto-renew on this page. Cancelling
                  needs 30 days' notice: it takes effect on the first billing
                  date that's at least 30 days after you ask, so you may be
                  charged one more time. You keep access until then. We don't
                  charge or refund for part of a month.
                </p>
              </details>
            </>
          )}
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <div className="membership-dialog__actions">
            <button className="button button--quiet" onClick={close}>
              Back
            </button>
            <button
              className="button button--primary"
              disabled={busy || (!free && !consent)}
              onClick={submit}
            >
              {free ? (
                "Claim free month"
              ) : (
                <>
                  <Lock aria-hidden="true" />
                  Continue to payment
                </>
              )}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
