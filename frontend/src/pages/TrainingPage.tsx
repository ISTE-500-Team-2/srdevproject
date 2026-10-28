import { useEffect, useState, type FormEvent } from "react";
import { MemberSelect } from "../components/MemberSelect";
import type { LiveEquipment } from "../lib/contracts";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "../components/Management";
import { Modal } from "../components/Modal";
import HoldButton from "../components/reactbits/HoldButton";
import { localInput, shortDate } from "../lib/display";
import type { ComplianceReport } from "../lib/staffContracts";
import { Check, Pencil, Plus, TriangleAlert } from "lucide-react";
import "./certwaiver.css";
type Course = {
  id: number;
  name: string;
  description: string;
  validityDays: number | null;
  revision: number;
  equipmentIds: number[];
};
type Record = {
  id: number;
  certificationId: number;
  name: string;
  status: string;
  valid: boolean;
  revision: number;
  expiresAt: string | null;
  trainedAt: string | null;
  revokedAt?: string | null;
  instructorName: string | null;
};
export function TrainingPage({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const roles = user?.roles ?? [];
  const permitted = roles.some((r) =>
    ["admin", "staff", "instructor"].includes(r),
  );
  if (!permitted)
    return (
      <section>
        <h1>Training management</h1>
        <p>Instructor or staff access is required.</p>
        <Link to="/certifications">Your certifications</Link>
      </section>
    );
  return (
    <TrainingWorkspace
      canConfigure={roles.some((r) => ["admin", "staff"].includes(r))}
      canApprove={roles.some((r) => ["admin", "instructor"].includes(r))}
      embedded={embedded}
    />
  );
}
function TrainingWorkspace({
  canConfigure,
  canApprove,
  embedded,
}: {
  canConfigure: boolean;
  canApprove: boolean;
  embedded: boolean;
}) {
  const catalog = useApi<Course[]>("/training/catalog");
  const equipment = useApi<LiveEquipment[]>("/equipment");
  const [equipmentSearch, setEquipmentSearch] = useState("");
  const [equipmentIds, setEquipmentIds] = useState<number[]>([]);
  const [memberId, setMemberId] = useState("");
  const [selectedMember, setSelectedMember] = useState("");
  const records = useApi<Record[]>(
    selectedMember ? `/training/users/${selectedMember}` : null,
  );
  const [editing, setEditing] = useState<Course | null>(null);
  useEffect(() => {
    setEquipmentIds(editing?.equipmentIds ?? []);
    setEquipmentSearch("");
  }, [editing]);
  const [renewing, setRenewing] = useState<Record | null>(null);
  const [revoking, setRevoking] = useState<Record | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await work();
      catalog.reload();
      if (selectedMember) records.reload();
      setMessage("Training records saved.");
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveCourse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(
        editing?.id ? `/training/catalog/${editing.id}` : "/training/catalog",
        {
          method: editing?.id ? "PATCH" : "POST",
          body: {
            name: f.get("name"),
            description: f.get("description"),
            validityDays: Number(f.get("days")),
            equipmentIds,
            reason: f.get("reason"),
            ...(editing?.id ? { expectedRevision: editing.revision } : {}),
          },
        },
      );
      setEditing(null);
      setEquipmentIds([]);
    });
  }
  async function approve(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(
        `/training/users/${selectedMember}/certifications/${f.get("certId")}`,
        {
          method: "POST",
          body: {
            trainedAt: new Date(String(f.get("trainedAt"))).toISOString(),
            source: f.get("source"),
            verifiedInPerson: f.get("verified") === "on",
            verificationReference: f.get("reference"),
            reason: f.get("reason"),
            ...(records.data?.find(
              (r) => r.certificationId === Number(f.get("certId")),
            )
              ? {
                  expectedRevision: records.data!.find(
                    (r) => r.certificationId === Number(f.get("certId")),
                  )!.revision,
                }
              : {}),
          },
        },
      );
      setRenewing(null);
    });
  }
  const stats = useApi<ComplianceReport>(canConfigure ? "/admin/compliance?userStatus=active" : null);
  const certified = new Map((stats.data?.certificationBreakdown ?? []).map((c) => [c.id, c]));
  const equipmentName = (id: number) => equipment.data?.find((e) => e.id === id)?.name ?? "Equipment";
  const current = selectedMember ? records.data ?? [] : [];
  const untrained = (catalog.data ?? []).filter((c) => !current.some((r) => r.certificationId === c.id));

  return (
    <div className={embedded ? "cw-section" : "management-page page-enter cw-section"}>
      {embedded ? null : <h1>Training &amp; certifications</h1>}
      <div className="cw-row">
        <p className="cw-muted">Training members must complete before they can use linked equipment.</p>
        {canConfigure ? (
          <button type="button" className="button button--primary cw-small" onClick={() => { setError(""); setEditing({ id: 0 } as Course); }}>
            <Plus aria-hidden="true" /> New certification
          </button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="form-notice">
          {message}
        </p>
      ) : null}
      <LoadState {...catalog} loading={catalog.loading && !catalog.data} />
      {catalog.data && !catalog.data.length ? (
        <p className="cw-muted">No certifications yet.{canConfigure ? " Add one to link training to equipment." : ""}</p>
      ) : null}
      <div className="cw-certs">
        {catalog.data?.map((c) => {
          const n = certified.get(c.id);
          return (
            <article className="cw-cert" key={c.id}>
              <div className="cw-cert__top">
                <h3>{c.name}</h3>
                {n ? (
                  <span className={`cw-tag cw-tag--${n.compliant ? "green" : "grey"}`}>{n.compliant} certified</span>
                ) : null}
              </div>
              {c.validityDays ? (
                <small className="cw-muted">Renew every {c.validityDays} days</small>
              ) : (
                <span className="cw-tag cw-tag--amber">
                  <TriangleAlert aria-hidden="true" /> Renewal period not set
                </span>
              )}
              <div className="cw-cert__equipment">
                {c.equipmentIds.length ? (
                  c.equipmentIds.map((id) => (
                    <span className="cw-tag cw-tag--grey" key={id}>
                      {equipmentName(id)}
                    </span>
                  ))
                ) : (
                  <small className="cw-muted">No equipment linked</small>
                )}
              </div>
              <div className="cw-cert__foot">
                <small className="cw-muted">
                  {n ? (n.expiring ? `${n.expiring} expiring soon` : n.compliant ? "All current" : "No one trained yet") : ""}
                </small>
                {canConfigure ? (
                  <button type="button" className="button button--quiet cw-small" onClick={() => { setError(""); setEditing(c); }} aria-label={`Configure ${c.name}`}>
                    <Pencil aria-hidden="true" /> Edit
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <section className="cw-records" aria-labelledby="records-title">
        <div className="cw-row">
          <h3 id="records-title">Member training records</h3>
        </div>
        <MemberSelect
          value={memberId}
          onChange={(id) => {
            setMemberId(id);
            setSelectedMember(id);
            setRenewing(null);
            setRevoking(null);
            setError("");
          }}
        />
        {selectedMember ? (
          <>
            <LoadState {...records} loading={records.loading && !records.data} />
            <ul className="cw-recs">
              {current.map((r) => (
                <li key={r.id}>
                  <div>
                    <b>{r.name}</b>
                    <small>
                      {r.trainedAt ? `Trained ${shortDate(r.trainedAt, true)}` : "Training date not recorded"}
                      {r.instructorName ? ` by ${r.instructorName}` : ""}
                    </small>
                    {r.status === "revoked" && r.revokedAt ? (
                      <small>Revoked {shortDate(r.revokedAt, true)}. New in-person training is needed before approving again.</small>
                    ) : null}
                  </div>
                  <div>
                    <span className={`cw-tag cw-tag--${r.valid ? "green" : r.status === "revoked" ? "red" : "amber"}`}>
                      {r.valid ? "Current" : "Not current"} · {r.status}
                    </span>
                    <small>{r.expiresAt ? `${r.valid ? "Expires" : "Expired"} ${shortDate(r.expiresAt, true)}` : "No expiry recorded"}</small>
                  </div>
                  <div className="cw-recs__actions">
                    {canApprove ? (
                      <button type="button" className="button button--quiet cw-small" onClick={() => { setError(""); setRenewing(r); }}>
                        {r.valid ? "Renew" : "Record new training"}
                      </button>
                    ) : null}
                    {canConfigure && r.status === "active" ? (
                      <button type="button" className="button cw-danger cw-small" onClick={() => { setError(""); setRevokeReason(""); setRevoking(r); }}>
                        Revoke
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
              {records.data
                ? untrained.map((c) => (
                    <li key={`new-${c.id}`}>
                      <div>
                        <b>{c.name}</b>
                        <small>Not trained</small>
                      </div>
                      <div />
                      <div className="cw-recs__actions">
                        {canApprove ? (
                          <button
                            type="button"
                            className="button button--primary cw-small"
                            onClick={() => { setError(""); setRenewing({ certificationId: c.id, name: c.name } as Record); }}
                          >
                            <Check aria-hidden="true" /> Record training
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))
                : null}
            </ul>
            {!canApprove ? <p className="cw-muted">An authorized instructor must verify and approve completed training.</p> : null}
          </>
        ) : (
          <p className="cw-muted">Pick a member to see their training.</p>
        )}
      </section>

      {editing ? (
        <Modal open width="panel" title={editing.id ? `Edit ${editing.name}` : "New certification"} onClose={() => setEditing(null)}>
          <form className="cw-form" key={editing.id} onSubmit={saveCourse}>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <label className="cw-field">
              <span>Name</span>
              <input name="name" required maxLength={100} defaultValue={editing.name} />
            </label>
            <label className="cw-field">
              <span>Description</span>
              <textarea name="description" maxLength={255} rows={3} defaultValue={editing.description} />
            </label>
            <div className="cw-hinted">
              <label className="cw-field">
                <span>Approved validity in days</span>
                <input name="days" type="number" min={1} max={3650} required defaultValue={editing.validityDays ?? ""} />
              </label>
              <small>How long training stays valid before it must be renewed.</small>
            </div>
            <fieldset className="cw-field cw-equipment">
              <legend>Equipment covered by this certification</legend>
              <label className="cw-field">
                <span>Find equipment</span>
                <input type="search" value={equipmentSearch} onChange={(e) => setEquipmentSearch(e.target.value)} />
              </label>
              <LoadState {...equipment} />
              <div className="cw-equipment__list">
                {equipment.data
                  ?.filter((item) => (item.name + " " + item.location).toLowerCase().includes(equipmentSearch.toLowerCase()))
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={equipmentIds.includes(item.id)}
                        onChange={(e) =>
                          setEquipmentIds((ids) => (e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id)))
                        }
                      />{" "}
                      {item.name} — {item.location}
                    </label>
                  ))}
              </div>
              <small>
                {equipmentIds.length} selected. A machine has one required certification, so selecting it here replaces
                its current link.
              </small>
            </fieldset>
            <label className="cw-field">
              <span>Policy approval/reference</span>
              <input name="reason" required maxLength={500} />
            </label>
            <div className="cw-form__actions">
              <button type="button" className="button button--quiet" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="button button--primary" disabled={busy || equipment.loading || !!equipment.error}>
                Save certification
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {renewing ? (
        <Modal open width="panel" title={`Record training: ${renewing.name}`} onClose={() => setRenewing(null)}>
          <form className="cw-form" key={renewing.certificationId} onSubmit={approve}>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <input type="hidden" name="certId" value={renewing.certificationId} />
            <label className="cw-field">
              <span>Actual training date/time</span>
              <input name="trainedAt" type="datetime-local" required max={localInput()} />
            </label>
            <label className="cw-field">
              <span>Training source</span>
              <select name="source">
                <option value="equipment">Equipment training</option>
                <option value="external">External training verified in person</option>
              </select>
            </label>
            <label className="cw-field">
              <span>Verification reference</span>
              <input name="reference" required maxLength={500} placeholder="e.g. Observed safe demonstration" />
            </label>
            <label className="cw-field">
              <span>Reason</span>
              <input name="reason" required maxLength={500} />
            </label>
            <label className="cw-check">
              <input name="verified" type="checkbox" required /> I conducted or verified this training in person.
            </label>
            <p className="cw-muted">Approval records your signed-in identity. Self-certification isn't allowed.</p>
            <div className="cw-form__actions">
              <button type="button" className="button button--quiet" onClick={() => setRenewing(null)}>
                Cancel
              </button>
              <button className="button button--primary" disabled={busy}>
                Approve training
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {revoking ? (
        <Modal open width="compact" title={`Revoke ${revoking.name}?`} onClose={() => setRevoking(null)}>
          <div className="cw-form">
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <p>The member loses access to linked equipment until new in-person training is recorded.</p>
            <label className="cw-field">
              <span>Revocation/retraining reason</span>
              <input value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} required maxLength={500} />
            </label>
            <div className="cw-form__actions">
              <button type="button" className="button button--quiet" onClick={() => setRevoking(null)}>
                Keep it
              </button>
              <HoldButton
                className="site-hold-button"
                disabled={busy || !revokeReason.trim()}
                holdTime={1200}
                radius={9}
                backgroundColor="#fff5f3"
                fillColor="#b73a2e"
                textColor="#b73a2e"
                fillTextColor="#ffffff"
                doneLabel="Revoking…"
                onHold={() => {
                  const r = revoking;
                  void run(() =>
                    api(`/training/users/${selectedMember}/certifications/${r.certificationId}/revoke`, {
                      method: "POST",
                      body: { expectedRevision: r.revision, reason: revokeReason },
                    }),
                  ).then((saved) => {
                    if (!saved) return;
                    setRevoking(null);
                    setRevokeReason("");
                  });
                }}
              >
                Hold to revoke {revoking.name}
              </HoldButton>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
