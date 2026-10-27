import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, errorMessage } from "../lib/api";
import type { MembershipHistory, Plan } from "../lib/staffContracts";
import type { Billing, BillingPass } from "../lib/billingContracts";
import { zonedDay } from "../lib/display";
import { LoadState } from "../components/Management";
import { AccessSummary, openBilling } from "../components/membership/AccessSummary";
import { PlanCards } from "../components/membership/PlanCards";
import { History } from "../components/membership/History";
import "./membership.css";

/** How long to keep checking for a payment after returning from checkout. */
const CONFIRM_WINDOW_MS = 60_000;

type Result = Record<string, unknown>;

export function MembershipPage() {
  const [params, setParams] = useSearchParams();
  const returned = params.get("billing") ?? params.get("pass");
  const [confirming, setConfirming] = useState(returned === "returned");
  const poll = { retainOnReload: true, refreshInterval: confirming ? 3000 : 60_000 };
  const history = useApi<MembershipHistory>("/me/memberships", poll);
  const billing = useApi<{ enabled: boolean; records: Billing[] }>("/me/billing", poll);
  const passes = useApi<BillingPass[]>("/me/billing/passes", poll);
  const plans = useApi<Plan[]>("/plans");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const started = useRef(Date.now());

  const refreshAll = useCallback(() => {
    history.reload();
    billing.reload();
    passes.reload();
  }, [history.reload, billing.reload, passes.reload]);

  // Coming back from checkout: keep checking until the payment clears, then
  // drop the query string so a page refresh doesn't repeat the message.
  useEffect(() => {
    if (!returned) return;
    if (returned === "cancelled") {
      setMessage({ text: "Checkout cancelled. You haven't been charged." });
      setParams({}, { replace: true });
      return;
    }
    if (!history.data || !billing.data || !passes.data) return;
    const waiting =
      openBilling(billing.data.records).some((r) => r.status === "pending") ||
      passes.data.some((p) => p.status === "pending") ||
      (params.has("billing") &&
        !history.data.memberships.some((m) => ["active", "scheduled"].includes(m.effectiveStatus)));
    if (!waiting) {
      setConfirming(false);
      setMessage({ text: "Payment received. You're all set." });
      setParams({}, { replace: true });
    } else if (Date.now() - started.current > CONFIRM_WINDOW_MS) {
      setConfirming(false);
      setMessage({
        text: "Your payment is still processing. This page will update when it clears.",
      });
      setParams({}, { replace: true });
    }
  }, [returned, params, setParams, history.data, billing.data, passes.data]);

  /** Posts an action. Redirects to checkout when the server returns a link. Throws on failure. */
  const post = useCallback(
    async (path: string, body: unknown = {}) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await api<Result>(path, { method: "POST", body });
        const url = (result.checkoutUrl ?? result.url) as string | undefined;
        if (url) {
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
    async (path: string, body: unknown, done: (result: Result) => string) => {
      try {
        const result = await post(path, body);
        if (!(result.checkoutUrl ?? result.url)) setMessage({ text: done(result) });
      } catch (e) {
        setMessage({ text: errorMessage(e), error: true });
      }
    },
    [post],
  );

  const act = useCallback(
    (path: string) =>
      run(path, {}, (r) => {
        if (path.includes("/passes/")) {
          if (r.manualRefundRequired)
            return "Day pass cancelled. Ask staff at the front desk for your refund.";
          if (r.refundStatus && r.refundStatus !== "succeeded")
            return "Day pass cancelled. Your refund is on its way.";
          return "Day pass cancelled.";
        }
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
          <LoaderCircle className="membership-spin" aria-hidden="true" />
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
          billing={openBilling(billing.data!.records)}
          memberships={history.data!.memberships}
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
