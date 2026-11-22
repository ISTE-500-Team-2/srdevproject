// Coordinates plan offers, effective access and payment history; provider-return polling waits for
// server reconciliation.

import { useCallback, useEffect, useState } from "react";
import type { StripeMode } from "../lib/stripeMode";
import { useSearchParams } from "react-router-dom";
import StatusMark from "../components/reactbits/StatusMark";
import { useApi } from "../lib/useApi";
import { api, errorMessage } from "../lib/api";
import type { MembershipHistory, Plan } from "../lib/staffContracts";
import type { Billing, BillingPass } from "../lib/billingContracts";
import { zonedDay } from "../lib/display";
import { LoadState } from "../components/Management";
import { AccessSummary, openBilling } from "../components/membership/AccessSummary";
import { PlanCards } from "../components/membership/PlanCards";
import { History } from "../components/membership/History";
import { forgetAssistedReturn } from "../lib/checkoutReturn";
import "./membership.css";

/** How long to keep checking for a payment after returning from checkout. */
const CONFIRM_WINDOW_MS = 60_000;

type Result = Record<string, unknown>;
type Message = { text: string; error?: boolean };

/**
 * Describes a day-pass cancellation from what the server actually reported.
 * Card refunds can still be in flight or fail, and the pass is only cancelled
 * once the refund succeeds, so only claim cancellation when it happened.
 */
function passCancelMessage(r: Result): string | Message {
  if (r.manualRefundRequired) return "Day pass cancelled. Ask staff at the front desk for your refund.";
  // A card payment that arrived when no pass could be issued only has a refund to report.
  if (r.passIssued === false) {
    if (r.cancelled === true || r.refundStatus === "succeeded") return "Your payment was refunded. No day pass was issued for it.";
    if (r.refundStatus === "failed" || r.refundStatus === "canceled")
      return {
        text: "We couldn't refund this payment. No day pass was issued for it. Please ask staff at the front desk.",
        error: true,
      };
    if (r.refundStatus === "pending" || r.refundStatus === "requires_action")
      return "Your refund is on its way. No day pass was issued for this payment. We'll email you when it's done.";
    return "We couldn't confirm your refund. Refresh this page to see its status, or ask staff at the front desk.";
  }
  if (r.cancelled === true || r.refundStatus === "succeeded") return "Day pass cancelled.";
  if (r.refundStatus === "pending" || r.refundStatus === "requires_action")
    return "Your day pass cancellation is waiting on the refund. We'll email you when it's done.";
  if (r.refundStatus === "failed" || r.refundStatus === "canceled")
    return {
      text: "We couldn't refund this day pass, so it is still active. Please ask staff at the front desk.",
      error: true,
    };
  return "We couldn't confirm your day pass cancellation. Refresh this page to see its status, or ask staff at the front desk.";
}

export function MembershipPage() {
  const [params, setParams] = useSearchParams();
  const returned = params.get("billing") ?? params.get("pass");
  const [confirming, setConfirming] = useState(returned === "returned");
  const poll = { retainOnReload: true, refreshInterval: confirming ? 3000 : 60_000 };
  const history = useApi<MembershipHistory>("/me/memberships", poll);
  const billing = useApi<{ enabled: boolean; mode?: StripeMode; records: Billing[] }>("/me/billing", poll);
  const passes = useApi<BillingPass[]>("/me/billing/passes", poll);
  const plans = useApi<Plan[]>("/plans");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmExpired, setConfirmExpired] = useState(false);

  const refreshAll = useCallback(() => {
    history.reload();
    billing.reload();
    passes.reload();
  }, [history.reload, billing.reload, passes.reload]);

  // The confirming window must end on time even when nothing else changes,
  // such as a status list that keeps failing to load.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirmExpired(true), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  // Coming back from checkout: keep checking until the payment clears, then
  // drop the query string so a page refresh doesn't repeat the message.
  useEffect(() => {
    if (!returned) return;
    if (returned === "cancelled") {
      setMessage({ text: "Checkout cancelled. You haven't been charged." });
      setParams({}, { replace: true });
      return;
    }
    const h = history.data, b = billing.data, p = passes.data;
    // A pass return names its checkout; older links fall back to pending passes still ahead.
    const checkout = params.get("checkout"), today = h ? zonedDay(h.timeZone) : "";
    // Wait only on what this return is about: an abandoned membership checkout
    // must not hold up a day-pass return (or a pending pass a membership one).
    const waiting = !h || !b || !p || (params.has("billing")
      ? openBilling(b.records).some((r) => r.status === "pending") ||
        !h.memberships.some((m) => ["active", "scheduled"].includes(m.effectiveStatus))
      : p.some((x) => x.status === "pending" && (checkout ? x.id === checkout : x.validDate >= today)));
    if (!waiting) {
      setConfirming(false);
      // A return URL is not payment evidence. Show the server-backed records
      // below without claiming that this particular checkout was paid.
      setMessage({ text: "Your current access and billing status are shown below." });
      setParams({}, { replace: true });
    } else if (confirmExpired) {
      setConfirming(false);
      setMessage({
        text: h && b && p
          ? "Your payment is still processing. This page will update when it clears."
          : "We couldn't check your payment status. Refresh this page in a moment.",
      });
      setParams({}, { replace: true });
    }
  }, [returned, params, setParams, history.data, billing.data, passes.data, confirmExpired]);

  /** Posts an action. Redirects to checkout when the server returns a link. Throws on failure. */
  const post = useCallback(
    async (path: string, body: unknown = {}) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await api<Result>(path, { method: "POST", body });
        const url = (result.checkoutUrl ?? result.url) as string | undefined;
        if (url) {
          forgetAssistedReturn();
          window.location.assign(url);
          return result;
        }
        refreshAll();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refreshAll],
  );

  /** Posts an action and reports the outcome in the page message. */
  const run = useCallback(
    async (path: string, body: unknown, done: (result: Result) => string | Message) => {
      try {
        const result = await post(path, body);
        if (!(result.checkoutUrl ?? result.url)) {
          const outcome = done(result);
          setMessage(typeof outcome === "string" ? { text: outcome } : outcome);
        }
      } catch (e) {
        setMessage({ text: errorMessage(e), error: true });
      }
    },
    [post],
  );

  const act = useCallback(
    (path: string) =>
      run(path, {}, (r) => {
        if (path.includes("/passes/")) return passCancelMessage(r);
        if (path.includes("/memberships/"))
          // A membership cancelled before it started has no last day: it never begins.
          return r.endsAt === null
            ? "Upcoming membership cancelled. It won't start."
            : "Membership cancelled. Your last day is shown below.";
        const record = billing.data?.records.find((b) => path.includes(b.id));
        return record?.status === "pending"
          ? "Checkout cancelled. You haven't been charged."
          : "Auto-renew stopped. Your last day is shown below once it's confirmed.";
      }),
    [run, billing.data],
  );

  const ready = history.data && billing.data && passes.data;
  return (
    <div className="page-enter management-page membership-page">
      <header>
        <p className="eyebrow">Account</p>
        <h1 className="display-heading">Membership &amp; passes</h1>
        <p className="membership-page__lead">
          See your access, buy passes, and manage billing.
        </p>
      </header>

      {confirming ? (
        <div className="membership-banner" role="status">
          <StatusMark status="running" size={24} color="#a86008" />
          <div>
            <strong>Confirming your payment…</strong>
            <span>This usually takes a few seconds. Your access will show here once it's confirmed.</span>
          </div>
        </div>
      ) : null}
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "form-error" : "membership-message"}
        >
          {message.text}
        </p>
      ) : null}

      <LoadState {...history} loading={history.loading && !history.data} />
      <LoadState {...billing} loading={false} />
      <LoadState {...passes} loading={false} />
      {ready ? (
        <AccessSummary
          history={history.data!}
          billing={billing.data!.records}
          passes={passes.data!}
          busy={busy}
          act={act}
        />
      ) : null}

      <LoadState {...plans} loading={plans.loading && !plans.data} />
      {plans.data && ready ? (
        <PlanCards
          plans={plans.data}
          billingEnabled={billing.data!.enabled}
          billingMode={billing.data!.mode}
          billing={openBilling(billing.data!.records)}
          memberships={history.data!.memberships}
          accessStatus={history.data!.accessStatus}
          today={zonedDay(history.data!.timeZone)}
          busy={busy}
          post={post}
          run={run}
        />
      ) : null}

      {history.data ? (
        <History memberships={history.data.memberships} passes={history.data.passes} />
      ) : null}
    </div>
  );
}
