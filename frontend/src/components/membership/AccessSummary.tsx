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
const closedPass = ["cancelled", "expired"];

export function openBilling(records: Billing[]) {
  return records.filter((r) => !closedBilling.includes(r.status));
}

export function upcomingPasses(passes: BillingPass[], today: string) {
  return passes
    .filter((p) => !closedPass.includes(p.status) && p.validDate >= today)
    .sort((a, b) => a.validDate.localeCompare(b.validDate));
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
  const records = openBilling(billing);
  const pending = records.find((r) => r.status === "pending");
  const recurring = records.find((r) => r.status !== "pending");
  const upcoming = upcomingPasses(passes, today);
  const [stopping, setStopping] = useState<Billing | null>(null);
  const [cancelling, setCancelling] = useState<BillingPass | null>(null);

  return (
    <section className="panel membership-status" aria-labelledby="access-heading">
      <Headline
        accessStatus={history.accessStatus}
        current={current}
        scheduled={scheduled}
        passToday={passToday}
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
      {upcoming.length ? (
        <div className="membership-passes">
          <div className="membership-passes__heading">
            <h3>Upcoming day passes</h3>
            <span>{upcoming.length} booked</span>
          </div>
          <ul>
            {upcoming.map((p) => (
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
            ))}
          </ul>
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
          30 days from today, so you may be charged one more time. You keep
          studio access until then, and we'll show your last day here.
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
        open={!!cancelling}
        title="Cancel day pass?"
        width="compact"
        onClose={() => setCancelling(null)}
      >
        {cancelling ? (
          <p>
            Your day pass for {shortDate(cancelling.validDate)} will be
            cancelled.{" "}
            {cancelling.id.startsWith("manual:")
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
  recurring,
  pending,
}: {
  accessStatus: string;
  current?: Entitlement;
  scheduled?: Entitlement;
  passToday?: Entitlement;
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
  } else if (pending || recurring) {
    icon = <Clock aria-hidden="true" />;
    tone = "warn";
    pill = "Payment pending";
    title = "Your membership is being set up";
    detail = pending
      ? "Finish checkout to start your membership."
      : "We're waiting for your payment to clear. This page updates on its own.";
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
  let renewal: string;
  if (ending && r.cancellationConfirmed)
    renewal = `Auto-renew is off. Your last day is ${shortDate(ending, true)}.`;
  else if (ending)
    renewal = `You asked to stop auto-renew from ${shortDate(ending, true)}. We're confirming this with the payment provider.`;
  else if (r.cancelAtPeriodEnd) renewal = "Auto-renew is off.";
  else
    renewal = r.currentPeriodEnd
      ? `Next charge ${cents(r.amountCents)} on ${shortDate(r.currentPeriodEnd)}`
      : `Renews automatically at ${cents(r.amountCents)} a month`;
  const renewing = !ending && !r.cancelAtPeriodEnd;
  return (
    <div className="membership-billing">
      <p className="membership-facts">
        <span>
          <Repeat aria-hidden="true" />
          {renewal}
        </span>
      </p>
      <div className="membership-actions">
        <button
          className="button button--quiet"
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
  if (p.status === "pending") {
    note = "Checkout not finished";
    action = "Cancel checkout";
  } else if (p.refundStatus && p.refundStatus !== "succeeded") {
    note =
      p.refundStatus === "failed" || p.refundStatus === "canceled"
        ? "Your refund didn't go through"
        : "Refund in progress";
    action = p.refundStatus === "failed" || p.refundStatus === "canceled" ? "Retry refund" : null;
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
          {p.plan?.name ?? "Day pass"} · {shortDate(p.validDate)}
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
