import {
  CalendarSync,
  ChevronRight,
  DoorOpen,
  Drill,
  GraduationCap,
  IdCard,
  Lock,
  Nfc,
  ScanLine,
  Ticket,
  TriangleAlert,
  UserCog,
  UserPen,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LoadState } from "../components/Management";
import { initials, roleLabel } from "../components/admin/people";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { Certification, Overview, Reservation } from "../lib/contracts";
import { dateTime } from "../lib/display";
import type { MemberDetail } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";

type Action = {
  icon: LucideIcon;
  title: string;
  detail: string;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  tag?: string;
};

function ActionRow({ icon: Icon, title, detail, to, onClick, disabled, tag }: Action) {
  const inner = (
    <>
      <span className="account-action__icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="account-action__text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {tag ? <span className="account-action__tag">{tag}</span> : null}
      {disabled ? null : <ChevronRight className="account-action__chevron" aria-hidden="true" />}
    </>
  );
  if (to && !disabled)
    return (
      <Link className="account-action" to={to}>
        {inner}
      </Link>
    );
  return (
    <button type="button" className="account-action" onClick={onClick} disabled={disabled || !onClick}>
      {inner}
    </button>
  );
}

function ActionGroup({ title, actions, tone }: { title: string; actions: Action[]; tone?: "tools" | "locked" }) {
  if (!actions.length) return null;
  return (
    <section className={`account-actions${tone ? ` account-actions--${tone}` : ""}`} aria-label={title}>
      <h2>{title}</h2>
      <div className="account-actions__grid">
        {actions.map((action) => (
          <ActionRow key={action.title} {...action} />
        ))}
      </div>
    </section>
  );
}

const expired = (status: string) => /expired|revoked|lapsed/i.test(status);

/**
 * What staff see on the member site's home page while they have someone's
 * account open: whose account it is and what they can do for them.
 */
export function AccountHomePage() {
  const { user, actor } = useAuth();
  const [checkIn, setCheckIn] = useState<{ busy: boolean; message: string; failed: boolean }>({
    busy: false,
    message: "",
    failed: false,
  });
  const overview = useApi<Overview>("/me/overview");
  const certifications = useApi<Certification[]>("/me/certifications");
  const bookings = useApi<Reservation[]>("/reservations");
  const detail = useApi<MemberDetail>(user ? `/admin/users/${user.id}` : null);
  if (!user || !actor) return null;

  const own = user.id === actor.id;
  const first = own ? "you" : user.firstName;
  const isAdmin = actor.roles.includes("admin");
  const memberRecord = `/admin/members?member=${user.id}`;

  const doCheckIn = async () => {
    setCheckIn({ busy: true, message: "", failed: false });
    try {
      await api("/me/check-ins", { method: "POST", body: {} });
      setCheckIn({ busy: false, message: `${own ? "You're" : `${user.firstName} is`} checked in.`, failed: false });
      overview.reload();
    } catch (err) {
      setCheckIn({ busy: false, message: errorMessage(err), failed: true });
    }
  };

  const o = overview.data;
  const membership = detail.data?.memberships.find((item) => item.effectiveStatus === "active");
  const pass = detail.data?.passes.find((item) => item.effectiveStatus === "active");
  const now = Date.now();
  const nextBooking = (bookings.data ?? [])
    .filter((item) => item.status === "confirmed" && Date.parse(item.startTime) > now)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))[0];
  const lastVisit = o?.recentCheckIns[0];
  const lapsed = (certifications.data ?? []).filter((item) => expired(item.status));

  const problems: { title: string; detail: string; action?: ReactNode }[] = [];
  if (o && !o.entitlement.membership && !o.entitlement.dayPass)
    problems.push({
      title: own ? "You have no active membership or day pass." : `${user.firstName} has no active membership or day pass.`,
      detail: "Most machines and rooms need one.",
      action: <Link className="button button--quiet account-heads__action" to="/membership">Change membership</Link>,
    });
  if (o && o.pendingWaivers > 0)
    problems.push({
      title: `${o.pendingWaivers} ${o.pendingWaivers === 1 ? "waiver needs" : "waivers need"} signing.`,
      detail: own
        ? "Sign them from Certifications & Waivers."
        : `${user.firstName} has to sign these in their own account.`,
    });
  for (const item of lapsed)
    problems.push({
      title: `${own ? "Your" : `${user.firstName}'s`} ${item.name} certification is ${item.status.toLowerCase()}.`,
      detail: "Machines that need it stay locked until an instructor signs it off again.",
      action: <Link className="button button--quiet account-heads__action" to="/classes">Find a class</Link>,
    });

  const onBehalf: Action[] = [
    { icon: Drill, title: "Book equipment", detail: own ? "Machines you're certified on" : `Machines ${user.firstName} is certified on`, to: "/equipment" },
    { icon: DoorOpen, title: "Book a studio", detail: "Hourly or monthly studio rental", to: "/studios" },
    { icon: GraduationCap, title: "Sign up for a class", detail: own ? "Enroll and pay" : "Enroll them and take payment", to: "/classes" },
    {
      icon: Nfc,
      title: own ? "Check in" : `Check ${user.firstName} in`,
      detail: checkIn.busy
        ? "Checking in…"
        : o && !o.canCheckIn
          ? (o.reasons[0] ?? "Not available right now")
          : "Record a visit without a tag",
      onClick: () => void doCheckIn(),
      disabled: checkIn.busy || !o?.canCheckIn,
    },
    { icon: IdCard, title: "Change membership", detail: own ? "Switch, renew or cancel your plan" : "Switch, renew or cancel their plan", to: "/membership" },
  ];
  // Staff tools open the workspace with this member already selected.
  const tools: Action[] = own
    ? []
    : [
        { icon: ScanLine, title: "Assign a tag", detail: `Scan a new NFC tag to ${user.firstName}`, to: `/admin/access?member=${user.id}` },
        { icon: Lock, title: "Pause access", detail: "Lock every reader until restored", to: memberRecord },
        { icon: Ticket, title: "Issue a pass or membership", detail: "Records the payment too", to: memberRecord },
        { icon: CalendarSync, title: "Move a booking", detail: "Move or cancel one of their bookings", to: `/admin/reservations?member=${user.id}` },
        { icon: UserPen, title: "Edit profile", detail: "Fix their name or phone number", to: memberRecord },
        ...(isAdmin
          ? [{ icon: UserCog, title: "Change role", detail: "Make them staff or an instructor", to: memberRecord, tag: "Admin" }]
          : []),
      ];
  const locked: Action[] = own
    ? []
    : [
        ...(isAdmin ? [] : [{ icon: UserCog, title: "Change role", detail: "Make them staff or an instructor", disabled: true, tag: "Admins" }]),
        { icon: GraduationCap, title: "Sign off training", detail: "An instructor confirms it in person", disabled: true, tag: "Instructors" },
      ];

  return (
    <div className="account-home page-enter">
      <aside className="panel account-snapshot" aria-label={own ? "Your account" : `${user.firstName}'s account`}>
        <div className="account-snapshot__head">
          <span className="admin-avatar admin-avatar--large" aria-hidden="true">
            {initials(user.firstName, user.lastName)}
          </span>
          <div>
            <h2>
              {user.firstName} {user.lastName}
            </h2>
            <p>{user.email}</p>
          </div>
        </div>
        <LoadState {...overview} loading={overview.loading && !overview.data} />
        <dl className="account-snapshot__rows">
          <div>
            <dt>Membership</dt>
            <dd>
              {membership?.plan?.name ? (
                <>
                  <strong>{membership.plan.name}</strong>
                  {membership.endsAt ? <span>Active until {dateTime(membership.endsAt)}</span> : <span>Active</span>}
                </>
              ) : pass?.plan?.name ? (
                <>
                  <strong>{pass.plan.name}</strong>
                  <span>Day pass</span>
                </>
              ) : o ? (
                <strong>{o.entitlement.membership ? "Active" : o.entitlement.dayPass ? "Day pass" : "None"}</strong>
              ) : (
                <span>…</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Waivers</dt>
            <dd>
              {o ? (
                <strong className={o.pendingWaivers ? "account-snapshot__bad" : ""}>
                  {o.pendingWaivers ? `${o.pendingWaivers} to sign` : "All signed"}
                </strong>
              ) : (
                <span>…</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Certified on</dt>
            <dd className="account-snapshot__tags">
              {certifications.data?.length ? (
                certifications.data.map((item) => (
                  <span key={item.id} className={`status-pill status-pill--${expired(item.status) ? "warn" : "neutral"}`}>
                    {item.name}
                    {expired(item.status) ? ", expired" : ""}
                  </span>
                ))
              ) : (
                <strong>{certifications.data ? "None yet" : "…"}</strong>
              )}
            </dd>
          </div>
          <div>
            <dt>Next booking</dt>
            <dd>
              {nextBooking ? (
                <>
                  <strong>{nextBooking.equipmentName}</strong>
                  <span>{dateTime(nextBooking.startTime)}</span>
                </>
              ) : (
                <strong>{bookings.data ? "None" : "…"}</strong>
              )}
            </dd>
          </div>
          <div>
            <dt>Last visit</dt>
            <dd>
              {lastVisit ? (
                <>
                  <strong>{dateTime(lastVisit.checkedInAt)}</strong>
                  <span>{lastVisit.location}</span>
                </>
              ) : (
                <strong>{o ? "No visits yet" : "…"}</strong>
              )}
            </dd>
          </div>
        </dl>
      </aside>
      <div className="account-ask">
        <h1>What would you like to do?</h1>
        <p className="account-ask__intro">
          {own
            ? `You're on the member site as ${roleLabel(actor).toLowerCase()} ${actor.firstName}. Pick something to do.`
            : `Pick an action for ${user.firstName}. Member actions open the same pages ${user.firstName} uses, filled in for their account.`}
        </p>
        {checkIn.message ? (
          <p className={checkIn.failed ? "form-error" : "form-notice"} role={checkIn.failed ? "alert" : "status"}>
            {checkIn.message}
          </p>
        ) : null}
        {problems.map((problem) => (
          <div className="account-heads" key={problem.title}>
            <TriangleAlert aria-hidden="true" />
            <div>
              <strong>{problem.title}</strong>
              <p>{problem.detail}</p>
            </div>
            {problem.action}
          </div>
        ))}
        <ActionGroup title={own ? "For you" : `On ${first}'s behalf`} actions={onBehalf} />
        <ActionGroup title={isAdmin ? "Admin tools" : "Staff tools"} actions={tools} tone="tools" />
        <ActionGroup title={isAdmin ? "Needs an instructor" : "Needs an instructor or admin"} actions={locked} tone="locked" />
      </div>
    </div>
  );
}
