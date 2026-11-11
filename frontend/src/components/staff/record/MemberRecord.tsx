import {
  Ban,
  CalendarClock,
  Check,
  ChevronRight,
  Eye,
  FilePenLine,
  GraduationCap,
  Info,
  Lock,
  LogIn,
  LogOut,
  Mail,
  Minus,
  Nfc,
  Pause,
  PenLine,
  Phone,
  Receipt,
  ShieldCheck,
  TriangleAlert,
  UserRoundCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { api, errorMessage } from "../../../lib/api";
import type { SupervisionSummary } from "../../../lib/contracts";
import { dollars, shortDate, timeOnly } from "../../../lib/display";
import type { NfcCard } from "../../../lib/nfc";
import type { Entitlement, MemberDetail, MemberRequirements, Person, Plan } from "../../../lib/staffContracts";
import { useApi } from "../../../lib/useApi";
import { Modal } from "../../Modal";
import { Toast } from "../../Toast";
import { paymentAction, paymentMethodName, paymentStatusName, paymentStatusTone, refundNote } from "../PaymentControls";
import { RecordDialogHost, type DialogState } from "./RecordDialogs";
import {
  accessWords,
  accountWords,
  activity,
  byDay,
  daysUntil,
  needs,
  phoneText,
  plans as planSplit,
  requirements,
  roleName,
  verdict,
  type ActivityRow,
  type NeedItem,
  type Requirement,
} from "./recordModel";
import "./memberRecord.css";

type Override = { id: number; kind: string; resourceName: string; endsAt: string; reason: string; revokedAt: string | null };
export interface ViewAs {
  onOpen: () => void;
  busy: boolean;
  error: string;
}

const VERDICT_ICONS: Record<string, LucideIcon> = { shield: ShieldCheck, pause: Pause, ban: Ban, login: LogIn, info: Info, alert: TriangleAlert };
const ROW_ICONS: Record<string, LucideIcon> = {
  login: LogIn,
  logout: LogOut,
  x: X,
  check: Check,
  nfc: Nfc,
  receipt: Receipt,
  pause: Pause,
  user: UserRoundCheck,
  shield: ShieldCheck,
  pen: PenLine,
  cap: GraduationCap,
  waiver: FilePenLine,
  calendar: CalendarClock,
};
const ENTITLEMENT_WORDS: Record<string, string> = {
  active: "Active",
  scheduled: "Starts later",
  suspended: "Paused",
  revoked: "Ended early",
  expired: "Ended",
  cancelled: "Cancelled",
};
const entitlementTone = (s: string) => (s === "active" ? "ok" : s === "suspended" || s === "scheduled" ? "warn" : "neutral");
const initials = (p: Pick<Person, "firstName" | "lastName">) => `${p.firstName[0] ?? ""}${p.lastName[0] ?? ""}`.toUpperCase();
const day = (value: string) => shortDate(value).replace(/^\w+, /, "");

/**
 * A member's whole record in the staff side panel: whether they can use the
 * shop right now and the next thing to do, then their membership, history and
 * payments beside what needs attention, their card and account settings.
 */
export function MemberRecord({
  id,
  name,
  plans,
  timeZone,
  onChanged,
  onClose,
  notice,
  viewAs,
}: {
  id: number;
  /** Shown until the record loads. */
  name: string;
  plans: Plan[];
  timeZone: string;
  onChanged: () => void;
  onClose: () => void;
  /** A one-time message for this visit, such as a return from checkout. */
  notice?: ReactNode;
  /** Opens the member site as this member; omitted when staff may not. */
  viewAs?: ViewAs;
}) {
  const { user: actor } = useAuth();
  const navigate = useNavigate();
  const detail = useApi<MemberDetail>(`/admin/users/${id}`, { retainOnReload: true, refreshInterval: 3000 });
  const req = useApi<MemberRequirements>(`/admin/users/${id}/requirements`, { retainOnReload: true, refreshInterval: 10000 });
  const supervision = useApi<SupervisionSummary>(`/admin/users/${id}/supervision`, { retainOnReload: true, refreshInterval: 15000 });
  const cards = useApi<NfcCard[]>(`/admin/access/cards?userId=${id}`, { retainOnReload: true });
  const overrides = useApi<Override[]>(`/admin/access/overrides?userId=${id}`, { retainOnReload: true });
  // Adopt a committed write's revision before the refresh lands, so a second save isn't stale.
  const [confirmed, setConfirmed] = useState<Person | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | ActivityRow["type"]>("all");
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const d = detail.data;
  const u = d && confirmed && confirmed.revision > d.user.revision ? confirmed : d?.user;
  const isAdmin = !!actor?.roles.includes("admin");
  const self = actor?.id === id;
  const canManage = !!u && (isAdmin || !u.roles.some((r) => r === "admin" || r === "staff"));
  const reloadAll = () => {
    detail.reload();
    req.reload();
    supervision.reload();
    cards.reload();
    overrides.reload();
    onChanged();
  };
  const done = (message: string) => {
    setDialog(null);
    setToast(message);
    reloadAll();
  };
  const visitAction = async (action: "check-in" | "check-out") => {
    if (!u) return;
    setBusy(true);
    setActionError("");
    try {
      await api(`/admin/users/${id}/supervision/${action}`, { method: "POST", body: {} });
      done(action === "check-in" ? `${u.firstName} checked in.` : `${u.firstName} checked out.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="mr-id">
      <span className={`admin-avatar admin-avatar--${(id % 4) + 1} mr-avatar`} aria-hidden="true">
        {initials(u ?? { firstName: name, lastName: name.split(" ")[1] ?? "" })}
      </span>
      <div className="mr-id__text">
        <h2>
          {u ? `${u.firstName} ${u.lastName}` : name}
          {supervision.data?.isMinor ? <span className="mr-tag">Under 18</span> : null}
          {u?.conductFlag ? <span className="mr-tag mr-tag--bad">Conduct flag</span> : null}
        </h2>
        {u ? (
          <p className="mr-sub">
            <span>
              <Mail aria-hidden="true" />
              {u.email}
            </span>
            <span>
              <Phone aria-hidden="true" />
              {u.phone ? (
                phoneText(u.phone)
              ) : canManage ? (
                <button type="button" className="today-link mr-add" onClick={() => setDialog({ kind: "profile" })}>
                  Add phone
                </button>
              ) : (
                "No phone"
              )}
            </span>
            <span className="mr-sub__id">#{u.id}</span>
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <Modal open width="panel" title={u ? `${u.firstName} ${u.lastName}` : name} header={header} onClose={onClose} className="mr-card">
      {notice}
      {!d ? (
        detail.error ? (
          <p role="alert" className="form-error">
            {detail.error}{" "}
            <button type="button" className="today-link" onClick={detail.reload}>
              Try again
            </button>
          </p>
        ) : (
          <p role="status" className="mr-loading">
            Loading {name}’s record…
          </p>
        )
      ) : null}
      {d && u ? (
        <Body
          person={u}
          detail={d}
          req={req.data}
          supervision={supervision.data}
          cards={cards.data}
          cardsError={cards.error}
          overrides={overrides.data}
          canManage={canManage}
          isAdmin={isAdmin}
          self={self}
          busy={busy}
          actionError={actionError}
          filter={filter}
          setFilter={setFilter}
          viewAs={viewAs}
          open={setDialog}
          visitAction={visitAction}
          go={navigate}
        />
      ) : null}
      {dialog && u ? (
        <RecordDialogHost
          dialog={dialog}
          person={u}
          plans={plans}
          timeZone={timeZone}
          supervision={supervision.data}
          onClose={() => setDialog(null)}
          onDone={done}
          onPerson={setConfirmed}
          onConflict={reloadAll}
        />
      ) : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </Modal>
  );
}

function Body({
  person: u,
  detail: d,
  req,
  supervision,
  cards,
  cardsError,
  overrides,
  canManage,
  isAdmin,
  self,
  busy,
  actionError,
  filter,
  setFilter,
  viewAs,
  open,
  visitAction,
  go,
}: {
  person: Person;
  detail: MemberDetail;
  req: MemberRequirements | null;
  supervision: SupervisionSummary | null;
  cards: NfcCard[] | null;
  cardsError: string;
  overrides: Override[] | null;
  canManage: boolean;
  isAdmin: boolean;
  self: boolean;
  busy: boolean;
  actionError: string;
  filter: "all" | ActivityRow["type"];
  setFilter: (f: "all" | ActivityRow["type"]) => void;
  viewAs?: ViewAs;
  open: (d: DialogState) => void;
  visitAction: (a: "check-in" | "check-out") => void;
  go: (path: string) => void;
}) {
  const audit = d.audit.items;
  const v = verdict({ person: u, req, supervision, audit });
  const reqs = requirements(u, req);
  const visit = supervision?.visit ?? null;
  const VerdictIcon = VERDICT_ICONS[v.icon] ?? Info;
  const first = u.firstName;
  const locked = !canManage ? "Only an administrator can change staff accounts." : "";
  const note = locked || (self ? "This is your account. You can update your name and phone; another administrator changes your status, access, roles and conduct flag." : "");

  // The one desk action that matters now.
  let primary: ReactNode = null;
  if (canManage && visit)
    primary = (
      <button type="button" className="button button--primary" disabled={busy} onClick={() => visitAction("check-out")}>
        <LogOut aria-hidden="true" />
        {busy ? "Checking out…" : "Check out"}
      </button>
    );
  else if (canManage && !self && u.status !== "active")
    primary = (
      <button type="button" className="button button--primary" onClick={() => open({ kind: "status", lift: true })}>
        <Check aria-hidden="true" />
        {u.status === "suspended" ? "Lift hold" : "Reopen account"}
      </button>
    );
  else if (canManage && !self && u.accessStatus !== "active")
    primary = (
      <button type="button" className="button button--primary" onClick={() => open({ kind: "access", restore: true })}>
        <Check aria-hidden="true" />
        Restore access
      </button>
    );
  else if (canManage && u.status === "active" && u.accessStatus === "active") {
    const blocked = v.tone === "bad" ? v.title : "";
    primary = (
      <button
        type="button"
        className="button button--primary"
        disabled={busy || !!blocked}
        title={blocked || undefined}
        aria-describedby="mr-verdict-detail"
        onClick={() => visitAction("check-in")}
      >
        <LogIn aria-hidden="true" />
        {busy ? "Checking in…" : "Check in"}
      </button>
    );
  }

  const { current, currentKind, earlier } = planSplit(d.memberships, d.passes);
  const rows = activity(audit);
  const shown = rows.filter((r) => filter === "all" || r.type === filter).slice(0, 15);
  const todo = needs({ person: u, req, audit, memberships: d.memberships, payments: d.payments.items, canManage });
  const liveOverrides = (overrides ?? []).filter((o) => !o.revokedAt && Date.parse(o.endsAt) > Date.now());
  const activeCards = (cards ?? []).filter((c) => c.active).sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const shownCard = activeCards[0] ?? null;
  const otherCards = (cards ?? []).filter((c) => c !== shownCard);
  const blockedCard = shownCard && (u.status !== "active" || u.accessStatus !== "active");

  const runNeed = (n: NeedItem) => {
    const a = n.action;
    if (a.kind === "link") go(a.href);
    else if (a.kind === "sell") open({ kind: "sell" });
    else if (a.kind === "renew") open({ kind: "sell", renewal: a.item });
    else if (a.kind === "entitlement") open({ kind: "entitlement", item: a.item, entitlementKind: "membership" });
    else if (a.kind === "payment") open({ kind: "payment", payment: a.payment });
    else open({ kind: "sponsor" });
  };
  const jump = (r: Requirement) => {
    if (r.key === "waiver") return go("/admin/certifications?section=compliance");
    if (r.key === "training") return go("/admin/certifications?section=certifications");
    const target = document.getElementById(`mr-${r.key === "card" ? "cards" : r.key === "account" ? "account" : r.key === "sponsor" ? "sponsor" : "plan"}-${u.id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.remove("mr-flash");
    void target.offsetWidth;
    target.classList.add("mr-flash");
  };

  return (
    <div className="mr-body">
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
        <div className="mr-actions">
          {primary}
          {viewAs ? (
            <button type="button" className="button button--quiet" disabled={viewAs.busy} onClick={viewAs.onOpen} title={`See the member site as ${first} does, and book or sign up for them.`}>
              <Eye aria-hidden="true" />
              {viewAs.busy ? "Opening…" : `View as ${first}`}
            </button>
          ) : null}
        </div>
        {actionError || viewAs?.error ? (
          <p role="alert" className="form-error mr-verdict__error">
            {actionError || viewAs?.error}
          </p>
        ) : null}
        {note ? (
          <p className="mr-verdict__lock">
            <Lock aria-hidden="true" />
            {note}
          </p>
        ) : null}
        {reqs.length ? (
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
        ) : null}
      </section>

      <div className="mr-grid">
        <div className="mr-col">
          <section className="today-panel" id={`mr-plan-${u.id}`} aria-labelledby={`mr-plan-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-plan-title-${u.id}`}>Membership</h2>
              {canManage ? (
                <button type="button" className="today-link" onClick={() => open({ kind: "sell" })}>
                  Sell or record a payment <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {current && currentKind ? (
              <CurrentPlan
                item={current}
                kind={currentKind}
                held={u.status === "suspended"}
                first={first}
                canManage={canManage}
                open={open}
              />
            ) : (
              <p className="today-empty">No current membership or day pass.{canManage ? " Sell one or record a payment taken at the desk." : ""}</p>
            )}
            {earlier.length ? (
              <>
                <p className="mr-sub-head">Earlier</p>
                {earlier.slice(0, 5).map(({ item, kind }) => (
                  <Row
                    key={`${kind}-${item.id}`}
                    icon="receipt"
                    title={
                      <>
                        {item.plan?.name ?? (kind === "membership" ? "Membership" : "Day pass")} <small>#{item.id}</small>
                      </>
                    }
                    detail={kind === "membership" ? `${day(item.startsAt!)} to ${day(item.endsAt!)}` : `Valid ${item.validDate ? day(item.validDate) : ""}`}
                    end={
                      <>
                        <span className={`status-pill status-pill--${entitlementTone(item.effectiveStatus)}`}>{ENTITLEMENT_WORDS[item.effectiveStatus] ?? item.effectiveStatus}</span>
                        {canManage && item.status !== "revoked" && item.effectiveStatus !== "expired" ? (
                          <button type="button" className="today-link" onClick={() => open({ kind: "entitlement", item, entitlementKind: kind })} aria-label={`Change ${item.plan?.name ?? kind} #${item.id}`}>
                            Change
                          </button>
                        ) : null}
                      </>
                    }
                  />
                ))}
                {earlier.length > 5 ? <p className="mr-more">{earlier.length - 5} older not shown.</p> : null}
              </>
            ) : null}
          </section>

          <section className="today-panel" aria-labelledby={`mr-act-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-act-title-${u.id}`}>Activity</h2>
              <div className="segmented" role="group" aria-label="Show">
                {(
                  [
                    ["all", "All"],
                    ["visit", "Visits"],
                    ["tap", "Card taps"],
                    ["change", "Changes"],
                  ] as const
                ).map(([f, label]) => (
                  <button key={f} type="button" className={filter === f ? "is-selected" : undefined} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {shown.length ? (
              byDay(shown).map((g) => (
                <div key={g.day} role="group" aria-label={g.day}>
                  <p className="mr-day">{g.day}</p>
                  {g.rows.map((r) => (
                    <Row key={r.id} icon={r.icon} tone={r.tone} title={r.title} detail={r.detail} end={<time dateTime={r.at}>{timeOnly(r.at)}</time>} />
                  ))}
                </div>
              ))
            ) : (
              <p className="today-empty">{rows.length ? "Nothing of this kind recently." : "Nothing recorded yet."}</p>
            )}
            <div className="today-panel-foot">
              <Link className="today-link" to="/admin/change-log">
                Open the change log <ChevronRight aria-hidden="true" />
              </Link>
            </div>
          </section>

          <section className="today-panel" aria-labelledby={`mr-pay-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-pay-title-${u.id}`}>Payments</h2>
              <span className="today-count">{d.payments.items.length}{d.payments.nextOffset != null ? "+" : ""}</span>
            </div>
            {d.payments.items.length ? (
              d.payments.items.slice(0, 6).map((p) => {
                const action = canManage ? paymentAction(p) : null;
                const note = refundNote(p);
                return (
                  <Row
                    key={p.id}
                    icon="receipt"
                    title={p.planName || "Payment"}
                    detail={`${day(p.recordedAt)} · ${paymentMethodName(p.method)}${p.reference ? ` · ${p.reference}` : ""} · #${p.id}`}
                    end={
                      <>
                        <strong>{dollars(p.amount)}</strong>
                        <span className="mr-row__pills">
                          <span className={`status-pill status-pill--${paymentStatusTone(p.status)}`}>{paymentStatusName(p.status)}</span>
                          {note ? <span className={`status-pill ${note === "Refund failed" ? "status-pill--danger" : "status-pill--warn"}`}>{note}</span> : null}
                          {action ? (
                            <button
                              type="button"
                              className="today-link"
                              aria-label={`${action === "refund" ? "Refund" : "Update"} payment #${p.id}`}
                              onClick={() => open(action === "refund" ? { kind: "refund", payment: p } : { kind: "payment", payment: p })}
                            >
                              {action === "refund" ? "Refund…" : "Update"}
                            </button>
                          ) : null}
                        </span>
                      </>
                    }
                  />
                );
              })
            ) : (
              <p className="today-empty">No payments recorded.</p>
            )}
            {d.payments.items.length ? (
              <div className="today-panel-foot">
                <Link className="today-link" to="/admin/payments">
                  {d.payments.items.length > 6 || d.payments.nextOffset != null ? "All payments" : "Open Payments"} <ChevronRight aria-hidden="true" />
                </Link>
              </div>
            ) : null}
          </section>
        </div>

        <div className="mr-col mr-col--side">
          {todo.length ? (
            <section className="today-panel" aria-labelledby={`mr-needs-title-${u.id}`}>
              <div className="today-panel-head">
                <h2 id={`mr-needs-title-${u.id}`}>Needs you</h2>
                <span className="today-count today-count--hot">{todo.length}</span>
              </div>
              {todo.map((n) => {
                const Icon = ROW_ICONS[n.icon] ?? Info;
                return (
                  <div className="today-todo" key={n.id}>
                    <span className={`today-todo-icon${n.alert ? " today-todo-icon--alert" : ""}`}>
                      <Icon aria-hidden="true" />
                    </span>
                    <div>
                      <span className="today-todo-title">{n.title}</span>
                      <p className="today-todo-detail">{n.detail}</p>
                      <button type="button" className="today-button" onClick={() => runNeed(n)}>
                        {n.action.label}
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          ) : null}

          {supervision?.isMinor ? (
            <section className="today-panel" id={`mr-sponsor-${u.id}`} aria-labelledby={`mr-sp-title-${u.id}`}>
              <div className="today-panel-head">
                <h2 id={`mr-sp-title-${u.id}`}>Sponsoring adult</h2>
                {canManage && !visit ? (
                  <button type="button" className="today-link" onClick={() => open({ kind: "sponsor" })}>
                    {supervision.sponsor ? "Change" : "Link one"} <ChevronRight aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {supervision.sponsor ? (
                <div className="mr-sponsor">
                  <span className="today-avatar today-avatar--2" aria-hidden="true">
                    {supervision.sponsor.name
                      .split(" ")
                      .map((w) => w[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <span className="today-who-text">
                    <span className="today-who-name">{supervision.sponsor.name}</span>
                    <span className="today-who-place">{req?.minor?.sponsorHere ? "In the building now" : "Not checked in"}</span>
                  </span>
                </div>
              ) : (
                <p className="today-empty">No adult is linked yet. {first} can’t check in without one.</p>
              )}
              {visit && supervision.sponsor ? <p className="today-empty mr-tight">To change the sponsor, check {first} out first.</p> : null}
            </section>
          ) : null}

          <section className="today-panel" id={`mr-cards-${u.id}`} aria-labelledby={`mr-card-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-card-title-${u.id}`}>{(cards ?? []).length > 1 ? "NFC cards" : "NFC card"}</h2>
              {canManage && shownCard ? (
                <button type="button" className="today-link" onClick={() => open({ kind: "assign" })}>
                  Add another <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {cardsError ? <p role="alert" className="form-error mr-pad">{cardsError}</p> : null}
            {shownCard ? (
              <>
                <div className="mr-nfc" data-state={blockedCard ? "held" : "active"} role="img" aria-label={`${shownCard.label}${shownCard.last4 ? `, card ending ${shownCard.last4}` : ""}, ${blockedCard ? "refused while the account is blocked" : "active"}`}>
                  <div className="mr-nfc__top">
                    <span className="mr-nfc__brand">THE COLLABORATORY</span>
                    <span className="mr-nfc__state">{blockedCard ? "Blocked" : "Active"}</span>
                  </div>
                  <Nfc className="mr-nfc__wave" aria-hidden="true" />
                  <div>
                    <div className="mr-nfc__label">{shownCard.label}</div>
                    <div className="mr-nfc__num">•••• •••• {shownCard.last4 ?? "····"}</div>
                  </div>
                </div>
                <p className="mr-nfc-meta">
                  {blockedCard
                    ? "Refused at every reader while the account or facility access is blocked."
                    : shownCard.lastUsedAt
                      ? `Last used ${day(shownCard.lastUsedAt)}, ${timeOnly(shownCard.lastUsedAt)}${shownCard.lastReader ? ` at ${shownCard.lastReader}` : ""}`
                      : "Not used yet."}
                </p>
                {canManage ? (
                  <div className="mr-nfc-actions">
                    <button type="button" className="today-button" onClick={() => open({ kind: "assign", replacement: shownCard })}>
                      Replace
                    </button>
                    <button type="button" className="today-button" onClick={() => open({ kind: "card", card: shownCard, action: "revoke" })}>
                      Revoke
                    </button>
                  </div>
                ) : null}
              </>
            ) : cards ? (
              <>
                <div className="mr-nfc mr-nfc--none">
                  <Nfc className="mr-nfc__wave" aria-hidden="true" />
                  <strong>No card yet</strong>
                  <span>Assign one so {first} can tap in at the readers.</span>
                </div>
                {canManage ? (
                  <div className="mr-nfc-actions">
                    <button type="button" className="today-button" onClick={() => open({ kind: "assign" })}>
                      Assign a card
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="today-empty" role="status">Loading cards…</p>
            )}
            {otherCards.length ? (
              <div className="mr-other-cards">
                {otherCards.map((c) => (
                  <Row
                    key={c.id}
                    icon="nfc"
                    title={`${c.label}${c.last4 ? ` ••${c.last4}` : ""}`}
                    detail={c.active ? (c.lastUsedAt ? `Last used ${day(c.lastUsedAt)}` : "Not used yet") : `Assigned ${day(c.assignedAt)}`}
                    end={
                      <>
                        <span className={`status-pill status-pill--${c.active ? "ok" : "neutral"}`}>{c.active ? "Active" : "Revoked"}</span>
                        {canManage ? (
                          <button type="button" className="today-link" onClick={() => open({ kind: "card", card: c, action: c.active ? "revoke" : "reactivate" })} aria-label={`${c.active ? "Revoke" : "Reactivate"} ${c.label}`}>
                            {c.active ? "Revoke" : "Reactivate"}
                          </button>
                        ) : null}
                      </>
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="mr-gap" />
            )}
          </section>

          <section className="today-panel" aria-labelledby={`mr-sup-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-sup-title-${u.id}`}>Supervised use</h2>
              {canManage ? (
                <button type="button" className="today-link" disabled={u.status !== "active" || u.accessStatus !== "active"} onClick={() => open({ kind: "supervise" })}>
                  Start <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {liveOverrides.length ? (
              liveOverrides.map((o) => (
                <Row
                  key={o.id}
                  icon="shield"
                  tone="ok"
                  title={o.resourceName}
                  detail={`Until ${timeOnly(o.endsAt)} · “${o.reason}”`}
                  end={
                    canManage ? (
                      <button type="button" className="today-link" onClick={() => open({ kind: "endSupervision", override: o })}>
                        End
                      </button>
                    ) : null
                  }
                />
              ))
            ) : (
              <p className="today-empty">
                {u.status !== "active" || u.accessStatus !== "active"
                  ? "Not available while the account or access is blocked."
                  : `Unlock one machine or room for ${first} for up to 30 minutes while you watch.`}
              </p>
            )}
          </section>

          <section className="today-panel" id={`mr-account-${u.id}`} aria-labelledby={`mr-acc-title-${u.id}`}>
            <div className="today-panel-head">
              <h2 id={`mr-acc-title-${u.id}`}>Account</h2>
            </div>
            <dl className="mr-facts">
              <Fact
                label="Account status"
                value={accountWords(u.status)}
                bad={u.status !== "active"}
                small={u.status !== "active" && u.accountReason ? `“${u.accountReason}”` : ""}
                lock={locked || (self ? "You can’t change your own status." : "")}
                onChange={() => open({ kind: "status" })}
              />
              <Fact
                label="Facility access"
                value={accessWords(u.accessStatus)}
                bad={u.accessStatus !== "active"}
                small={u.accessStatus !== "active" && u.accessReason ? `“${u.accessReason}”` : ""}
                lock={locked || (self ? "You can’t change your own access." : "")}
                onChange={() => open({ kind: "access" })}
              />
              <Fact
                label="Roles"
                value={roleName(u.primaryRole ?? u.roles[0] ?? "member")}
                small={[
                  u.roles.filter((r) => r !== u.primaryRole).map(roleName).join(", ") ? `Also ${u.roles.filter((r) => r !== u.primaryRole).map(roleName).join(", ")}` : "",
                  u.isStudent ? "Student" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                lock={locked || (self ? "Another administrator has to change your roles." : !isAdmin ? "Only administrators change roles." : "")}
                onChange={() => open({ kind: "roles" })}
              />
              <Fact
                label="Conduct flag"
                value={u.conductFlag ? "On" : "Off"}
                bad={u.conductFlag}
                lock={locked || (self ? "Another administrator has to change your conduct flag." : "")}
                onChange={() => open({ kind: "conduct" })}
              />
              <Fact
                label="Name & phone"
                value={`${u.firstName} ${u.lastName}`}
                small={u.phone ? phoneText(u.phone) : "No phone on file"}
                lock={locked}
                edit
                onChange={() => open({ kind: "profile" })}
              />
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function CurrentPlan({
  item,
  kind,
  held,
  first,
  canManage,
  open,
}: {
  item: Entitlement;
  kind: "membership" | "day_pass";
  held: boolean;
  first: string;
  canManage: boolean;
  open: (d: DialogState) => void;
}) {
  const name = item.plan?.name ?? (kind === "membership" ? "Membership" : "Day pass");
  const price = item.plan?.price ? dollars(item.plan.price) : "";
  const pay = item.cardBilled ? "card, renews automatically" : "paid at the desk";
  let bar: ReactNode;
  if (kind === "membership" && item.startsAt && item.endsAt) {
    const start = Date.parse(item.startsAt),
      end = Date.parse(item.endsAt),
      now = Date.now();
    const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
    const left = daysUntil(item.endsAt);
    const leftText = now < start ? `Starts ${day(item.startsAt)}` : left <= 0 ? "Ends today" : `${left} ${left === 1 ? "day" : "days"} left`;
    bar = (
      <>
        <div className="today-bar" role="img" aria-label={`${leftText}; ends ${day(item.endsAt)}`}>
          <span className="today-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="mr-plan__dates">
          <span>{day(item.startsAt)}</span>
          <strong>{leftText}</strong>
          <span>{day(item.endsAt)}</span>
        </div>
      </>
    );
  } else bar = <p className="mr-plan__dates"><strong>Valid {item.validDate ? day(item.validDate) : "today"}, until closing</strong></p>;
  return (
    <div className="mr-plan">
      <div className="mr-plan__top">
        <span className="mr-plan__name">
          {name}
          <span className={`status-pill status-pill--${entitlementTone(item.effectiveStatus)}`}>{ENTITLEMENT_WORDS[item.effectiveStatus] ?? item.effectiveStatus}</span>
        </span>
        <span className="mr-plan__price">{[price && (kind === "membership" ? `${price} a month` : price), kind === "membership" ? pay : ""].filter(Boolean).join(" · ")}</span>
      </div>
      {bar}
      {item.cancellationRequestedAt ? <p className="mr-plan__note">{first} asked to cancel; it ends on the date shown and won’t renew.</p> : null}
      {held && item.effectiveStatus === "active" ? <p className="mr-plan__note">Still running{item.cardBilled ? " and billing" : ""} while {first} is on hold.</p> : null}
      {canManage && item.status !== "revoked" ? (
        <div className="mr-plan__buttons">
          {kind === "membership" && item.endsAt && !item.cardBilled ? (
            <button type="button" className="today-button" onClick={() => open({ kind: "sell", renewal: item })}>
              Renew
            </button>
          ) : null}
          <button type="button" className="today-button" onClick={() => open({ kind: "entitlement", item, entitlementKind: kind })}>
            {kind === "membership" ? "Pause or end" : "Change status"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ icon, tone = "neutral", title, detail, end }: { icon: string; tone?: "ok" | "alert" | "neutral"; title: ReactNode; detail?: string; end?: ReactNode }) {
  const Icon = ROW_ICONS[icon] ?? Info;
  return (
    <div className="mr-row">
      <span className={`today-todo-icon${tone === "alert" ? " today-todo-icon--alert" : tone === "ok" ? " mr-icon--ok" : ""}`}>
        <Icon aria-hidden="true" />
      </span>
      <span className="mr-row__text">
        <span className="mr-row__title">{title}</span>
        {detail ? <span className="mr-row__detail">{detail}</span> : null}
      </span>
      {end ? <span className="mr-row__end">{end}</span> : null}
    </div>
  );
}

function Fact({
  label,
  value,
  small,
  bad = false,
  lock,
  edit = false,
  onChange,
}: {
  label: string;
  value: string;
  small?: string;
  bad?: boolean;
  lock: string;
  edit?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="mr-fact">
      <dt>{label}</dt>
      <dd className={bad ? "is-bad" : undefined}>
        {value}
        {small ? <small>{small}</small> : null}
        {lock ? (
          <span className="mr-lock">
            <Lock aria-hidden="true" />
            {lock}
          </span>
        ) : null}
      </dd>
      {lock ? null : (
        <button type="button" className="today-link" onClick={onChange} aria-label={`${edit ? "Edit" : "Change"} ${label.toLowerCase()}`}>
          {edit ? "Edit" : "Change"}
        </button>
      )}
    </div>
  );
}
