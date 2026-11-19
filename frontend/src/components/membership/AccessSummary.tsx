// Combines effective access with billing state so a pending checkout is not presented as an active
// membership.

import { useState } from "react";
import {
  CalendarCheck,
  CircleCheck,
  Clock,
  CreditCard,
  Lock,
  Repeat,
  ShieldAlert,
} from "lucide-react";
import type { Billing, BillingPass } from "../../lib/billingContracts";
import type { Entitlement, MembershipHistory } from "../../lib/staffContracts";
import { cents, shortDate, zonedDay } from "../../lib/display";
import { Modal } from "../Modal";
import { StatusPill } from "./StatusPill";
import { lastCancelDay } from "./dates";

const closedBilling = ["canceled", "expired", "incomplete_expired"];
// Staff revoke a pass for good; a suspended one stays listed as on hold.
const closedPass = ["cancelled", "expired", "revoked"];
// Subscription states where a charge failed and the member must update their card.
const failedBilling = ["past_due", "unpaid", "incomplete", "paused"];

/**
 * Keep unfinished or ongoing billing records visible; terminal subscriptions no longer offer
 * billing actions.
 */
export function openBilling(records: Billing[]) {
  return records.filter((r) => !closedBilling.includes(r.status));
}

/** A refund that returned nothing. */
const refundFailed = (p: BillingPass) => p.refundStatus === "failed" || p.refundStatus === "canceled";
/** A card payment that arrived when no pass could be issued, so it is only a refund, never a booking. */
const unissued = (p: BillingPass) => p.passIssued === false;
const byDate = (a: BillingPass, b: BillingPass) => a.validDate.localeCompare(b.validDate);

/**
 * Show today's and future booked passes in date order, including checkouts whose payment is still
 * pending.
 */
export function upcomingPasses(passes: BillingPass[], today: string) {
  return passes
    .filter((p) => !closedPass.includes(p.status) && !unissued(p) && p.validDate >= today)
    .sort(byDate);
}

/**
 * Refunds still open outside the bookings: payments that never became a pass, and past passes whose
 * refund failed, which would otherwise drop off the page.
 */
export function openRefunds(passes: BillingPass[], today: string) {
  return passes
    .filter((p) => !closedPass.includes(p.status) && (
      (unissued(p) && (p.status === "pending" || p.refundStatus || p.cancelRequested)) ||
      (p.validDate < today && (refundFailed(p) || p.refundStatus === "needs_review"))
    ))
    .sort(byDate);
}

type Act = (path: string) => Promise<unknown>;

interface Props {
  history: MembershipHistory;
  billing: Billing[];
  passes: BillingPass[];
  busy: boolean;
  act: Act;
}

export function AccessSummary({ history, billing, passes, busy, act }: Props) {
  const today = zonedDay(history.timeZone);
  const current = history.memberships.find(
    (m) => m.effectiveStatus === "active",
  );
  const scheduled = history.memberships.find(
    (m) => m.effectiveStatus === "scheduled",
  );
  const passToday = history.passes.find((p) => p.effectiveStatus === "active");
  const nextPass = history.passes
    .filter((p) => p.effectiveStatus === "scheduled" && p.validDate)
    .sort((a, b) => a.validDate!.localeCompare(b.validDate!))[0];
  const records = openBilling(billing);
  const pending = records.find((r) => r.status === "pending");
  const recurring = records.find((r) => r.status !== "pending");
  const upcoming = upcomingPasses(passes, today);
  const refunds = openRefunds(passes, today);
  const [stopping, setStopping] = useState<Billing | null>(null);
  const [cancelling, setCancelling] = useState<BillingPass | null>(null);
  const [ending, setEnding] = useState<Entitlement | null>(null);
  // FR-057: a desk (or free) membership the member can cancel themselves: running now, on hold
  // but not yet over, or scheduled to start. Card memberships stop through auto-renew instead, but
  // a card membership still running out doesn't hide the cancel button on a desk one.
  const now = Date.now();
  const notStarted = (m: Entitlement) => !!m.startsAt && new Date(m.startsAt).getTime() > now;
  const deskMemberships = history.memberships.filter(
    (m) =>
      !m.cardBilled &&
      (m.effectiveStatus === "active" ||
        m.effectiveStatus === "scheduled" ||
        (m.effectiveStatus === "suspended" && !!m.endsAt && new Date(m.endsAt).getTime() > now)),
  );
  const passRow = (p: BillingPass) => (
    <PassRow
      key={p.id}
      pass={p}
      busy={busy}
      onCancel={() =>
        p.status === "pending" || p.refundStatus
          ? act(`/me/billing/passes/${p.id}/cancel`)
          : setCancelling(p)
      }
    />
  );

  return (
    <section className="panel membership-status" aria-labelledby="access-heading">
      <Headline
        accessStatus={history.accessStatus}
        current={current}
        scheduled={scheduled}
        passToday={passToday}
        nextPass={nextPass}
        recurring={recurring}
        pending={pending}
      />
      {recurring || pending ? (
        <BillingDetails
          record={(recurring ?? pending)!}
          busy={busy}
          onPortal={(r) => act(`/me/billing/${r.id}/portal`)}
          onStop={setStopping}
          onCancelCheckout={(r) => act(`/me/billing/${r.id}/cancel`)}
        />
      ) : null}
      {deskMemberships.map((m) => (
        <div className="membership-billing" key={m.id}>
          {m.cancellationRequestedAt ? (
            <p className="membership-muted">
              You cancelled this membership. Your last day is {shortDate(m.endsAt!, true)}.
            </p>
          ) : (
            <>
              {notStarted(m) ? (
                <p className="membership-muted">
                  {m.plan?.name ?? "Membership"} starts {shortDate(m.startsAt!, true)}
                  {m.effectiveStatus === "suspended" ? " and is on hold" : ""}.
                </p>
              ) : m.effectiveStatus === "suspended" ? (
                <p className="membership-muted">{m.plan?.name ?? "Your membership"} is on hold.</p>
              ) : null}
              <div className="membership-actions">
                <button className="button button--quiet" disabled={busy} onClick={() => setEnding(m)}>
                  {notStarted(m) ? "Cancel upcoming membership" : "Cancel membership"}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {upcoming.length ? (
        <div className="membership-passes">
          <div className="membership-passes__heading">
            <h3>Upcoming day passes</h3>
            <span>{upcoming.length} booked</span>
          </div>
          <ul>{upcoming.map(passRow)}</ul>
        </div>
      ) : null}
      {refunds.length ? (
        <div className="membership-passes">
          <div className="membership-passes__heading">
            <h3>Day pass refunds</h3>
          </div>
          <ul>{refunds.map(passRow)}</ul>
        </div>
      ) : null}

      <Modal
        open={!!stopping}
        title="Stop auto-renew?"
        width="compact"
        onClose={() => setStopping(null)}
      >
        <p>
          Cancelling takes effect on the first billing date that's at least
          30 days from today, so you may be charged one more time.{" "}
          {/* After a failed charge access has already lapsed, so don't promise it. */}
          {stopping && failedBilling.includes(stopping.status)
            ? "Your payment didn't go through, so you won't have studio access unless you update your payment method."
            : "You keep studio access until then, and we'll show your last day here."}
        </p>
        <div className="membership-dialog__actions">
          <button className="button button--quiet" onClick={() => setStopping(null)}>
            Keep auto-renew
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={async () => {
              const r = stopping!;
              setStopping(null);
              await act(`/me/billing/${r.id}/cancel`);
            }}
          >
            Stop auto-renew
          </button>
        </div>
      </Modal>

      <Modal
        open={!!ending}
        title={ending && notStarted(ending) ? "Cancel upcoming membership?" : "Cancel membership?"}
        width="compact"
        onClose={() => setEnding(null)}
      >
        {ending && notStarted(ending) ? (
          <p>
            Your membership starting {shortDate(ending.startsAt!, true)} will be
            cancelled now, so it won't start. If you paid at the front desk,
            ask staff about any refund.
          </p>
        ) : (
          <p>
            Cancelling takes 30 days of notice.{" "}
            {ending?.effectiveStatus === "suspended"
              ? "Your membership stays on hold until then, or until its current end date if that comes first, and it won't renew."
              : "You keep studio access until then, or until your current end date if that comes first, and your membership won't renew."}{" "}
            If you paid at the front desk, ask staff about any refund.
          </p>
        )}
        <div className="membership-dialog__actions">
          <button className="button button--quiet" onClick={() => setEnding(null)}>
            Keep membership
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={async () => {
              const m = ending!;
              setEnding(null);
              await act(`/me/billing/memberships/${m.id}/cancel`);
            }}
          >
            Cancel membership
          </button>
        </div>
      </Modal>

      <Modal
        open={!!cancelling}
        title="Cancel day pass?"
        width="compact"
        onClose={() => setCancelling(null)}
      >
        {cancelling ? (
          <p>
            Your day pass for {shortDate(cancelling.validDate)} will be
            cancelled.{" "}
            {cancelling.amountCents === 0
              ? "This pass was free, so there's nothing to refund."
              : cancelling.id.startsWith("manual:")
                ? "If you paid at the front desk, staff will refund you the same way you paid."
                : "We'll refund the full amount to your card."}
          </p>
        ) : null}
        <div className="membership-dialog__actions">
          <button className="button button--quiet" onClick={() => setCancelling(null)}>
            Keep pass
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={async () => {
              const p = cancelling!;
              setCancelling(null);
              await act(`/me/billing/passes/${p.id}/cancel`);
            }}
          >
            Cancel day pass
          </button>
        </div>
      </Modal>
    </section>
  );
}

function Headline({
  accessStatus,
  current,
  scheduled,
  passToday,
  nextPass,
  recurring,
  pending,
}: {
  accessStatus: string;
  current?: Entitlement;
  scheduled?: Entitlement;
  passToday?: Entitlement;
  nextPass?: Entitlement;
  recurring?: Billing;
  pending?: Billing;
}) {
  let icon = <Lock aria-hidden="true" />,
    tone: "ok" | "warn" | "neutral" = "neutral",
    pill = "No active access",
    title = "You don't have a membership or pass yet",
    detail = "Choose an option below to start using the studios.";
  if (accessStatus !== "active") {
    icon = <ShieldAlert aria-hidden="true" />;
    tone = "warn";
    pill = accessStatus === "revoked" ? "Access revoked" : "Access on hold";
    title = "Your studio access is on hold";
    detail = "Please talk to staff at the front desk.";
  } else if (current) {
    icon = <CircleCheck aria-hidden="true" />;
    tone = "ok";
    pill = "Active";
    title = current.endsAt
      ? `You're a member through ${shortDate(current.endsAt)}`
      : "You're a member";
    detail = current.plan?.name ?? "Membership";
  } else if (passToday) {
    icon = <CalendarCheck aria-hidden="true" />;
    tone = "ok";
    pill = "Active";
    title = "You have a day pass for today";
    detail = passToday.plan?.name ?? "Day pass";
  } else if (scheduled) {
    icon = <Clock aria-hidden="true" />;
    tone = "warn";
    pill = "Starts soon";
    title = scheduled.startsAt
      ? `Your membership starts ${shortDate(scheduled.startsAt)}`
      : "Your membership starts soon";
    detail = scheduled.plan?.name ?? "Membership";
  } else if (recurring && failedBilling.includes(recurring.status)) {
    // Incomplete is a first checkout whose payment never cleared, so there's no membership to keep yet.
    const first = recurring.status === "incomplete";
    icon = <CreditCard aria-hidden="true" />;
    tone = "warn";
    pill = first ? "Payment pending" : "Payment failed";
    title = first
      ? "Your first payment hasn't gone through"
      : "Your last payment didn't go through";
    detail = `Update your payment method to ${first ? "start" : "keep"} your membership.`;
  } else if (pending || recurring) {
    icon = <Clock aria-hidden="true" />;
    tone = "warn";
    pill = "Payment pending";
    title = "Your membership is being set up";
    detail = pending
      ? "Finish checkout to start your membership."
      : "We're waiting for your payment to clear. This page updates on its own.";
  } else if (nextPass) {
    icon = <CalendarCheck aria-hidden="true" />;
    tone = "ok";
    pill = "Booked";
    title = `Your next day pass is ${shortDate(nextPass.validDate!)}`;
    detail = nextPass.plan?.name ?? "Day pass";
  }
  return (
    <div className="membership-status__main">
      <span className={`membership-status__icon membership-status__icon--${tone}`}>
        {icon}
      </span>
      <div>
        <StatusPill tone={tone}>{pill}</StatusPill>
        <h2 id="access-heading" className="membership-status__title">
          {title}
        </h2>
        <p className="membership-muted">{detail}</p>
      </div>
    </div>
  );
}

function BillingDetails({
  record: r,
  busy,
  onPortal,
  onStop,
  onCancelCheckout,
}: {
  record: Billing;
  busy: boolean;
  onPortal: (r: Billing) => void;
  onStop: (r: Billing) => void;
  onCancelCheckout: (r: Billing) => void;
}) {
  if (r.status === "pending")
    return (
      <div className="membership-billing">
        <p className="membership-facts">
          <span>
            <CreditCard aria-hidden="true" />
            {r.plan.name} · {cents(r.amountCents)} a month · checkout not finished
          </span>
        </p>
        <div className="membership-actions">
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => onCancelCheckout(r)}
          >
            Cancel checkout
          </button>
        </div>
      </div>
    );
  const ending = r.cancellationEffectiveAt;
  // A failed charge has no next charge date to promise; the member needs to fix their card.
  const failed = failedBilling.includes(r.status);
  // Any stop-auto-renew state still shows beside a failed payment, so "Try again" reads as retrying that.
  let renewal: string | null = null;
  if (ending && r.cancellationConfirmed)
    renewal = `Auto-renew is off. Your last day is ${shortDate(ending, true)}.`;
  else if (ending)
    renewal = `You asked to stop auto-renew from ${shortDate(ending, true)}. We're confirming this with the payment provider.`;
  else if (r.cancelAtPeriodEnd) renewal = "Auto-renew is off.";
  else if (!failed)
    renewal = r.currentPeriodEnd
      ? `Next charge ${cents(r.amountCents)} on ${shortDate(r.currentPeriodEnd)}`
      : `Renews automatically at ${cents(r.amountCents)} a month`;
  const renewing = !ending && !r.cancelAtPeriodEnd;
  return (
    <div className="membership-billing">
      {failed ? (
        <p className="membership-facts">
          <span>
            <CreditCard aria-hidden="true" />
            {r.plan.name} · {cents(r.amountCents)} a month ·{" "}
            {r.status === "incomplete" ? "first payment not finished" : "payment failed"}
          </span>
        </p>
      ) : null}
      {renewal ? (
        <p className="membership-facts">
          <span>
            <Repeat aria-hidden="true" />
            {renewal}
          </span>
        </p>
      ) : null}
      <div className="membership-actions">
        <button
          className={failed ? "button button--primary" : "button button--quiet"}
          disabled={busy}
          onClick={() => onPortal(r)}
        >
          <CreditCard aria-hidden="true" />
          Manage payment method
        </button>
        {renewing ? (
          <button
            className="button membership-link-button"
            disabled={busy}
            onClick={() => onStop(r)}
          >
            Stop auto-renew
          </button>
        ) : ending && !r.cancellationConfirmed ? (
          <button
            className="button membership-link-button"
            disabled={busy}
            onClick={() => onStop(r)}
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PassRow({
  pass: p,
  busy,
  onCancel,
}: {
  pass: BillingPass;
  busy: boolean;
  onCancel: () => void;
}) {
  const day = Number(p.validDate.slice(8, 10));
  const monthName = new Date(`${p.validDate}T12:00:00`)
    .toLocaleDateString("en-US", { month: "short" })
    .toUpperCase();
  const deadlinePassed = new Date(p.cancelBy).getTime() < Date.now();
  let note: string;
  let action: string | null = null;
  if (p.refundStatus === "needs_review") {
    note = "Refund needs staff review. Please contact the front desk.";
  } else if (p.status === "suspended") {
    note = "On hold. Please contact staff about this pass.";
  } else if (p.status === "pending") {
    note = "Checkout not finished";
    action = "Cancel checkout";
  } else if (p.refundStatus === "partial") {
    note = "Part of this payment was refunded. Contact the front desk about any further refund.";
  } else if ((p.refundStatus && p.refundStatus !== "succeeded") || unissued(p)) {
    if (!refundFailed(p)) note = "Refund in progress";
    // The server retries after the cancel-by deadline only a refund the member's own cancellation
    // started; a staff refund of a used or late pass is staff's to retry.
    else if (p.cancelRequested || !deadlinePassed) {
      note = "Your refund didn't go through";
      action = "Retry refund";
    } else note = "Your refund didn't go through. Ask staff at the front desk about this refund.";
  } else if (deadlinePassed) {
    note = "Too late to cancel for a refund";
  } else {
    note = `Free cancellation through ${lastCancelDay(p.validDate)}`;
    action = "Cancel";
  }
  return (
    <li className="membership-pass">
      <span className="membership-pass__date" aria-hidden="true">
        <small>{monthName}</small>
        <b>{day}</b>
      </span>
      <div className="membership-pass__body">
        <strong>
          {unissued(p)
            ? `${p.plan?.name ?? "Day pass"} payment for ${shortDate(p.validDate)} (no pass issued)`
            : `${p.plan?.name ?? "Day pass"} · ${shortDate(p.validDate)}`}
        </strong>
        <span>{note}</span>
      </div>
      {action ? (
        <button className="button button--quiet" disabled={busy} onClick={onCancel}>
          {action}
        </button>
      ) : null}
    </li>
  );
}
