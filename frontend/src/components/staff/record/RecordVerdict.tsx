import { Ban, Check, Eye, Info, Lock, LogIn, LogOut, Minus, Pause, ShieldCheck, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { MemberRequirements, Person } from "../../../lib/staffContracts";
import { requirements, type Requirement, type Verdict } from "./recordModel";
import type { OpenDialog } from "./recordParts";

export interface ViewAs {
  onOpen: () => void;
  busy: boolean;
  error: string;
}

const VERDICT_ICONS: Record<string, LucideIcon> = { shield: ShieldCheck, pause: Pause, ban: Ban, login: LogIn, info: Info, alert: TriangleAlert };

/** Whether the member can use the shop right now, the desk actions, and the requirements behind it. */
export function RecordVerdict({
  verdict: v,
  actions,
  stale,
  error,
  note,
  children,
}: {
  verdict: Verdict;
  actions: ReactNode;
  /** A failed refresh of part of the record, with a way to re-read the failed parts. */
  stale?: { error: string; reload: () => void };
  error: string;
  /** Why some changes are locked, if they are. */
  note: string;
  /** The requirement list. */
  children: ReactNode;
}) {
  const VerdictIcon = VERDICT_ICONS[v.icon] ?? Info;
  return (
    <section className="today-panel mr-verdict" data-tone={v.tone} aria-labelledby="mr-verdict-title">
      <div className="mr-lead">
        <span className="mr-lead__icon">
          <VerdictIcon aria-hidden="true" />
        </span>
        <div>
          <h3 id="mr-verdict-title">{v.title}</h3>
          <p id="mr-verdict-detail">
            {v.quote ? <q>{v.quote}</q> : null} {v.detail}
          </p>
        </div>
      </div>
      <div className="mr-actions">{actions}</div>
      {stale ? (
        <p role="status" className="form-error mr-verdict__stale">
          Part of this record could not be refreshed, so it may be out of date. {stale.error}{" "}
          <button type="button" className="today-link" onClick={stale.reload}>
            Reload
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error mr-verdict__error">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="mr-verdict__lock">
          <Lock aria-hidden="true" />
          {note}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/** The one desk action that matters now, if any. */
export function DeskAction({
  person: u,
  inBuilding,
  blockedBy,
  canManage,
  self,
  busy,
  open,
  visitAction,
}: {
  person: Pick<Person, "status" | "accessStatus">;
  /** The member has an open visit. */
  inBuilding: boolean;
  /** Why check-in is refused, or empty when it isn't. */
  blockedBy: string;
  canManage: boolean;
  self: boolean;
  busy: boolean;
  open: OpenDialog;
  visitAction: (a: "check-in" | "check-out") => void;
}) {
  if (canManage && inBuilding)
    return (
      <button type="button" className="button button--primary" disabled={busy} onClick={() => visitAction("check-out")}>
        <LogOut aria-hidden="true" />
        {busy ? "Checking out…" : "Check out"}
      </button>
    );
  if (canManage && !self && u.status !== "active")
    return (
      <button type="button" className="button button--primary" onClick={() => open({ kind: "status", lift: true })}>
        <Check aria-hidden="true" />
        {u.status === "suspended" ? "Lift hold" : "Reopen account"}
      </button>
    );
  if (canManage && !self && u.accessStatus !== "active")
    return (
      <button type="button" className="button button--primary" onClick={() => open({ kind: "access", restore: true })}>
        <Check aria-hidden="true" />
        Restore access
      </button>
    );
  if (canManage && u.status === "active" && u.accessStatus === "active")
    return (
      <button
        type="button"
        className="button button--primary"
        disabled={busy || !!blockedBy}
        title={blockedBy || undefined}
        aria-describedby="mr-verdict-detail"
        onClick={() => visitAction("check-in")}
      >
        <LogIn aria-hidden="true" />
        {busy ? "Checking in…" : "Check in"}
      </button>
    );
  return null;
}

/** Opens the member site as this member. */
export function ViewAsButton({ viewAs, first }: { viewAs: ViewAs; first: string }) {
  return (
    <button type="button" className="button button--quiet" disabled={viewAs.busy} onClick={viewAs.onOpen} title={`See the member site as ${first} does, and book or sign up for them.`}>
      <Eye aria-hidden="true" />
      {viewAs.busy ? "Opening…" : `View as ${first}`}
    </button>
  );
}

/**
 * Each requirement for using the shop. A requirement handled on another page opens it;
 * the rest scroll to their section of the record and flash it.
 */
export function RequirementList({ person, req, go }: { person: Person; req: MemberRequirements | null; go: (path: string) => void }) {
  const reqs = requirements(person, req);
  const jump = (r: Requirement) => {
    if (r.key === "waiver") return go("/admin/certifications?section=compliance");
    if (r.key === "training") return go("/admin/certifications?section=certifications");
    const target = document.getElementById(`mr-${r.key === "card" ? "cards" : r.key === "account" ? "account" : r.key === "sponsor" ? "sponsor" : "plan"}-${person.id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.remove("mr-flash");
    void target.offsetWidth;
    target.classList.add("mr-flash");
  };
  if (!reqs.length) return null;
  return (
    <ul className="mr-reqs" aria-label="Requirements">
      {reqs.map((r) => (
        <li key={r.key}>
          <button type="button" className="mr-req" data-state={r.state} aria-label={r.description} title={r.description} onClick={() => jump(r)}>
            <span className="mr-req__mark">{r.state === "ok" ? <Check aria-hidden="true" /> : r.state === "bad" ? <X aria-hidden="true" /> : <Minus aria-hidden="true" />}</span>
            <span className="mr-req__label">{r.label}</span>
            <span className="mr-req__value">{r.value}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
