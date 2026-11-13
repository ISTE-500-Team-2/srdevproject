import { Mail, Phone } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { api, errorMessage } from "../../../lib/api";
import type { SupervisionSummary } from "../../../lib/contracts";
import type { NfcCard } from "../../../lib/nfc";
import type { MemberDetail, MemberRequirements, Person, Plan } from "../../../lib/staffContracts";
import { useApi } from "../../../lib/useApi";
import { useFailure } from "../../../lib/useFailure";
import { Modal } from "../../Modal";
import { Toast } from "../../Toast";
import { RecordAccount } from "./RecordAccount";
import { RecordActivity, type ActivityFilter } from "./RecordActivity";
import { RecordCards } from "./RecordCards";
import { RecordDialogHost, type DialogState } from "./RecordDialogs";
import { RecordMembership } from "./RecordMembership";
import { RecordNeeds } from "./RecordNeeds";
import { RecordPayments } from "./RecordPayments";
import { RecordSponsor } from "./RecordSponsor";
import { RecordSupervision, type Override } from "./RecordSupervision";
import { DeskAction, RecordVerdict, RequirementList, ViewAsButton, type ViewAs } from "./RecordVerdict";
import { phoneText, verdict } from "./recordModel";
import "./memberRecord.css";

export type { ViewAs };

const initials = (p: Pick<Person, "firstName" | "lastName">) => `${p.firstName[0] ?? ""}${p.lastName[0] ?? ""}`.toUpperCase();

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
  const cards = useApi<NfcCard[]>(`/admin/access/cards?userId=${id}`, { retainOnReload: true, refreshInterval: 15000 });
  const overrides = useApi<Override[]>(`/admin/access/overrides?userId=${id}`, { retainOnReload: true, refreshInterval: 15000 });
  // A failed refresh keeps the older record on screen; the verdict says so instead of
  // passing it off as current. Before the record loads, its own error shows instead.
  const failures = [
    { result: detail, error: useFailure(detail) },
    { result: req, error: useFailure(req) },
    { result: supervision, error: useFailure(supervision) },
    { result: overrides, error: useFailure(overrides) },
  ].filter((failure) => failure.error && (failure.result !== detail || detail.data));
  const stale = failures.length
    ? { error: failures[0].error, reload: () => failures.forEach((failure) => failure.result.reload()) }
    : undefined;
  // Adopt a committed write's revision before the refresh lands, so a second save isn't stale.
  const [confirmed, setConfirmed] = useState<Person | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [allEarlier, setAllEarlier] = useState(false);
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
  const locked = !canManage ? "Only an administrator can change staff accounts." : "";
  const v = d && u ? verdict({ person: u, req: req.data, supervision: supervision.data, audit: d.audit.items }) : null;
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
      {d && u && v ? (
        <div className="mr-body">
          <RecordVerdict
            verdict={v}
            actions={
              <>
                <DeskAction
                  person={u}
                  inBuilding={!!supervision.data?.visit}
                  blockedBy={v.tone === "bad" ? v.title : ""}
                  canManage={canManage}
                  self={self}
                  busy={busy}
                  open={setDialog}
                  visitAction={visitAction}
                />
                {viewAs ? <ViewAsButton viewAs={viewAs} first={u.firstName} /> : null}
              </>
            }
            stale={stale}
            error={actionError || viewAs?.error || ""}
            note={locked || (self ? "This is your account. You can update your name and phone; another administrator changes your status, access, roles and conduct flag." : "")}
          >
            <RequirementList person={u} req={req.data} go={navigate} />
          </RecordVerdict>

          <div className="mr-grid">
            <div className="mr-col">
              <RecordMembership
                person={u}
                memberships={d.memberships}
                passes={d.passes}
                canManage={canManage}
                allEarlier={allEarlier}
                showAllEarlier={() => setAllEarlier(true)}
                open={setDialog}
              />
              <RecordActivity personId={u.id} audit={d.audit.items} filter={filter} setFilter={setFilter} />
              <RecordPayments personId={u.id} payments={d.payments} canManage={canManage} open={setDialog} />
            </div>

            <div className="mr-col mr-col--side">
              <RecordNeeds
                person={u}
                req={req.data}
                audit={d.audit.items}
                memberships={d.memberships}
                payments={d.payments.items}
                canManage={canManage}
                open={setDialog}
                go={navigate}
              />
              {supervision.data?.isMinor ? (
                <RecordSponsor person={u} supervision={supervision.data} sponsorHere={!!req.data?.minor?.sponsorHere} canManage={canManage} open={setDialog} />
              ) : null}
              <RecordCards person={u} cards={cards.data} error={cards.error} canManage={canManage} open={setDialog} />
              <RecordSupervision person={u} overrides={overrides.data} canManage={canManage} open={setDialog} />
              <RecordAccount person={u} locked={locked} self={self} isAdmin={isAdmin} open={setDialog} />
            </div>
          </div>
        </div>
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
