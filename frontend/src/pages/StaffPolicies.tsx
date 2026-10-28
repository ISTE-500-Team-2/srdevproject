import { Archive, Check, Clock, Eye, FileText, History, Pencil, Plus, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { ComplianceReport, Policy } from "../lib/staffContracts";
import { LoadState } from "../components/Management";
import { Modal } from "../components/Modal";
import HoldButton from "../components/reactbits/HoldButton";
import { dateTime, localInput, shortDate } from "../lib/display";
import { documentText } from "../lib/documentText";
import "./certwaiver.css";

type Waiver = { name: string; current: Policy | null; upcoming: Policy | null; versions: Policy[] };

/** Groups every version under its waiver name, newest first. */
function groupWaivers(policies: Policy[], now = Date.now()): Waiver[] {
  const byName = new Map<string, Policy[]>();
  for (const p of policies) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  return [...byName.entries()]
    .map(([name, list]) => {
      const versions = list.sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt));
      const active = versions.filter((p) => p.active);
      return {
        name,
        current: active.find((p) => Date.parse(p.effectiveAt) <= now) ?? null,
        upcoming: active.find((p) => Date.parse(p.effectiveAt) > now) ?? null,
        versions,
      };
    })
    .sort((a, b) => Number(!a.current) - Number(!b.current) || a.name.localeCompare(b.name));
}

/** Next version label: dated versions take the start date, numbered ones count up. */
export function suggestVersion(previous: string | undefined, startsOn: string) {
  if (!previous || /^\d{4}-\d{2}-\d{2}$/.test(previous)) return startsOn;
  const numbered = previous.match(/^(.*?)(\d+)$/);
  return numbered ? numbered[1] + String(Number(numbered[2]) + 1) : startsOn;
}

/** Tomorrow at 9:00 in the browser's time, as a datetime-local value. */
function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return localInput(d);
}

function PublishPanel({
  waiver,
  activeMembers,
  onClose,
  onPublished,
}: {
  waiver: Waiver | null;
  activeMembers: number | null;
  onClose: () => void;
  onPublished: () => void;
}) {
  const latest = waiver?.upcoming ?? waiver?.current ?? null;
  const [effectiveAt, setEffectiveAt] = useState(tomorrowMorning);
  const [version, setVersion] = useState(() => suggestVersion(latest?.version, tomorrowMorning().slice(0, 10)));
  const [text, setText] = useState(latest?.description ?? "");
  const [name, setName] = useState(waiver?.name ?? "");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<{ name: string; error?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRun = useRef(0);
  const [importing, setImporting] = useState(false);
  // Fills the text box from PDF, Word or text files; the wording is still
  // reviewed (and editable) before publishing.
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const run = ++importRun.current;
    setImporting(true);
    try {
      const fileText = await documentText(file);
      if (run !== importRun.current) return;
      setText(fileText);
      setTab("edit");
      setImported({
        name: file.name,
        error: fileText.length > 16000 ? `That's ${fileText.length.toLocaleString()} characters; the limit is 16,000. Shorten it before publishing.` : undefined,
      });
    } catch (err) {
      if (run === importRun.current) setImported({ name: file.name, error: (err as Error).message });
    } finally {
      if (run === importRun.current) setImporting(false);
    }
  };
  const starts = effectiveAt ? new Date(effectiveAt) : null;
  const startsLabel = starts && Number.isFinite(starts.getTime()) ? dateTime(starts) : "the start date";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (importing) return;
    if (text.trim().length < 20 || text.length > 16000) {
      setError("Waiver text must contain between 20 and 16,000 characters. Review the text before publishing.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/admin/policies", {
        method: "POST",
        body: {
          name: name.trim(),
          version: version.trim(),
          description: text,
          effectiveAt: new Date(effectiveAt).toISOString(),
          approvalReference: form.get("approvalReference"),
          reason: form.get("reason"),
        },
      });
      onPublished();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open width="panel" title={waiver ? `Update ${waiver.name}` : "New waiver"} onClose={onClose}>
      <form className="cw-form" onSubmit={(e) => void submit(e)}>
        <div className="cw-two">
          <label className="cw-field">
            <span>Waiver</span>
            {waiver ? (
              <input value={waiver.name} readOnly aria-readonly="true" className="is-locked" />
            ) : (
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="e.g. Laser room rules" />
            )}
          </label>
          <div className="cw-hinted">
            <label className="cw-field">
              <span>New version</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} required maxLength={50} />
            </label>
            {latest ? <small>Current: {latest.version}</small> : null}
          </div>
        </div>
        <div className="cw-field">
          <span className="cw-field__row">
            <span id="waiver-text-label">Text members will read</span>
            <span className="cw-field__tools">
            <button type="button" className="button button--quiet cw-small" disabled={importing || busy} onClick={() => fileInput.current?.click()}>
              <Upload aria-hidden="true" /> {importing ? "Reading document…" : "Upload document"}
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".pdf,.docx,.txt,.md,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <span className="cw-toggle" role="tablist" aria-label="Text view">
              <button type="button" role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")}>
                Edit
              </button>
              <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
                Preview
              </button>
            </span>
            </span>
          </span>
          {tab === "edit" ? (
            <textarea
              className={dragging ? "is-dragging" : ""}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void importFile(e.dataTransfer.files[0]);
              }}
              aria-describedby="waiver-text-hint"
              aria-labelledby="waiver-text-label"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              minLength={20}
              maxLength={16000}
              rows={10}
              placeholder="Paste the approved wording, or drop a PDF, Word or text document here"
            />
          ) : (
            <div className="cw-preview" aria-labelledby="waiver-text-label">
              <h4>{name || "Untitled waiver"}</h4>
              <p className="policy-text">{text || "Nothing to preview yet."}</p>
            </div>
          )}
          <small id="waiver-text-hint" className={imported?.error ? "cw-hint cw-hint--error" : "cw-hint"} role={imported ? "status" : undefined}>
            {imported?.error
              ? `${imported.name}: ${imported.error}`
              : imported
                ? `Filled in from ${imported.name}. Check the wording and formatting before publishing; only the text is saved.`
                : "PDF, Word (.docx) or text files. Review the extracted wording before publishing. Only the text is saved, not the file."}
          </small>
        </div>
        <div className="cw-two">
          <div className="cw-hinted">
            <label className="cw-field">
              <span>Takes effect</span>
              <input type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} required />
            </label>
            <small>Members keep the current version until then.</small>
          </div>
          <div className="cw-hinted">
            <label className="cw-field">
              <span>Approval reference</span>
              <input name="approvalReference" maxLength={500} placeholder="e.g. Board vote Oct 21" />
            </label>
            <small>Where this wording was approved.</small>
          </div>
        </div>
        <p className="cw-impact">
          <TriangleAlert aria-hidden="true" />
          <span>
            <b>
              {activeMembers === null
                ? "Every active member"
                : `${activeMembers} active ${activeMembers === 1 ? "member" : "members"}`}{" "}
              will need to sign {waiver ? "again" : "it"}
            </b>{" "}
            from {startsLabel}. Until they do, they can't check in. Past signatures are kept.
          </span>
        </p>
        <label className="cw-field">
          <span>Reason for the change log</span>
          <input name="reason" required maxLength={255} placeholder="e.g. Updated guest policy" />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="cw-form__actions">
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy || importing}>
            <Check aria-hidden="true" /> {busy ? "Publishing…" : "Publish version"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RetireDialog({ policy, onClose, onRetired }: { policy: Policy; onClose: () => void; onRetired: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const retire = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/policies/${policy.id}/retire`, { method: "POST", body: { reason } });
      onRetired();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open width="compact" title={`Retire ${policy.name}?`} onClose={onClose}>
      <div className="cw-form">
        <p>
          Members will no longer be asked to sign version {policy.version}. If no required waiver is left, nobody can
          check in until one is published. A retired version can't be brought back.
        </p>
        <label className="cw-field">
          <span>Reason for the change log</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} required />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="cw-form__actions">
          <button type="button" className="button button--quiet" onClick={onClose}>
            Keep it
          </button>
          <HoldButton
            className="site-hold-button"
            disabled={busy || !reason.trim()}
            holdTime={1200}
            radius={9}
            backgroundColor="#fff5f3"
            fillColor="#b73a2e"
            textColor="#b73a2e"
            fillTextColor="#ffffff"
            icon={<Archive size={16} aria-hidden="true" />}
            doneLabel="Retiring…"
            onHold={() => void retire()}
          >
            Hold to retire
          </HoldButton>
        </div>
      </div>
    </Modal>
  );
}

export function StaffPolicies() {
  const policies = useApi<Policy[]>("/admin/policies");
  const compliance = useApi<ComplianceReport>("/admin/compliance?userStatus=active");
  const { user } = useAuth();
  const isAdmin = !!user?.roles.includes("admin");
  const [publishing, setPublishing] = useState<{ waiver: Waiver | null } | null>(null);
  const [retiring, setRetiring] = useState<Policy | null>(null);
  const [reading, setReading] = useState<Policy | null>(null);
  const waivers = groupWaivers(policies.data ?? []);
  const signed = new Map((compliance.data?.waiverBreakdown ?? []).map((w) => [w.id, w]));
  const activeMembers = compliance.data ? compliance.data.summary.userCount : null;
  const refresh = () => {
    policies.reload();
    compliance.reload();
  };

  return (
    <section className="cw-section">
      <div className="cw-row">
        <p className="cw-muted">Members sign the current version of every required waiver before they can check in.</p>
        {isAdmin ? (
          <button type="button" className="button button--primary cw-small" onClick={() => setPublishing({ waiver: null })}>
            <Plus aria-hidden="true" /> New waiver
          </button>
        ) : null}
      </div>
      <LoadState {...policies} loading={policies.loading && !policies.data} />
      {policies.data && !waivers.length ? <p className="cw-muted">No waivers yet.</p> : null}
      {waivers.map((w) => {
        const shown = w.current ?? w.upcoming ?? w.versions[0]!;
        const stats = w.current ? signed.get(w.current.id) : undefined;
        const scheduled = w.versions.filter((p) => p !== shown && p.active && Date.parse(p.effectiveAt) > Date.now());
        const earlier = w.versions.filter((p) => p !== shown && !scheduled.includes(p));
        return (
          <article className="cw-waiver" key={w.name}>
            <div>
              <div className="cw-waiver__title">
                <h3>{w.name}</h3>
                {!w.current && !w.upcoming ? (
                  <span className="cw-tag cw-tag--grey">Retired</span>
                ) : shown.required ? (
                  <span className="cw-tag cw-tag--dark">Required</span>
                ) : (
                  <span className="cw-tag cw-tag--grey">Optional</span>
                )}
              </div>
              <div className="cw-waiver__meta">
                <span>
                  <FileText aria-hidden="true" /> Version {shown.version}
                </span>
                <span>
                  <Clock aria-hidden="true" />
                  {w.current ? `In effect since ${shortDate(shown.effectiveAt, true)}` : w.upcoming ? `Starts ${dateTime(shown.effectiveAt)}` : "Retired"}
                </span>
                {w.current && w.upcoming ? (
                  <span className="cw-tag cw-tag--amber">
                    Version {w.upcoming.version} starts {shortDate(w.upcoming.effectiveAt)}
                  </span>
                ) : null}
                {!shown.approvalReference ? (
                  <span className="cw-tag cw-tag--amber">
                    <TriangleAlert aria-hidden="true" /> No approval reference
                  </span>
                ) : (
                  <span className="cw-muted">Approved: {shown.approvalReference}</span>
                )}
              </div>
            </div>
            {stats ? (
              <div className="cw-waiver__signed">
                <div className={`cw-bar${stats.total && stats.compliant / stats.total < 0.5 ? " cw-bar--low" : ""}`} aria-hidden="true">
                  <i style={{ width: `${stats.total ? Math.round((stats.compliant / stats.total) * 100) : 100}%` }} />
                </div>
                <small>
                  {stats.compliant} of {stats.total} active members signed
                </small>
              </div>
            ) : (
              <div />
            )}
            <div className="cw-waiver__actions">
              <button type="button" className="button button--quiet cw-small" onClick={() => setReading(shown)}>
                <Eye aria-hidden="true" /> View text
              </button>
              {isAdmin && (w.current || w.upcoming) ? (
                <button type="button" className="button button--quiet cw-small" onClick={() => setPublishing({ waiver: w })}>
                  <Pencil aria-hidden="true" /> Publish new version
                </button>
              ) : null}
              {earlier.length ? (
                <details className="cw-older">
                  <summary>
                    <History aria-hidden="true" /> {earlier.length} earlier {earlier.length === 1 ? "version" : "versions"}
                  </summary>
                  <ul>
                    {earlier.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="cw-link" onClick={() => setReading(p)}>
                          Version {p.version}
                        </button>{" "}
                        · {p.active ? "Active" : "Retired"} · from {shortDate(p.effectiveAt, true)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {isAdmin && shown.active ? (
                <button type="button" className="button cw-danger cw-small cw-push" aria-label={`Retire ${w.name} ${shown.version}`} onClick={() => setRetiring(shown)}>
                  <Archive aria-hidden="true" /> Retire
                </button>
              ) : null}
            </div>
            {scheduled.length ? (
              <div className="cw-waiver__scheduled">
                <h4>Scheduled versions</h4>
                {scheduled.map((p) => (
                  <div className="cw-row" key={p.id}>
                    <span>Version {p.version} · starts {dateTime(p.effectiveAt)}</span>
                    <div className="cw-waiver__actions">
                      <button type="button" className="button button--quiet cw-small" aria-label={`View ${w.name} ${p.version}`} onClick={() => setReading(p)}>
                        <Eye aria-hidden="true" /> View text
                      </button>
                      {isAdmin ? (
                        <button type="button" className="button cw-danger cw-small" aria-label={`Retire ${w.name} ${p.version}`} onClick={() => setRetiring(p)}>
                          <Archive aria-hidden="true" /> Retire
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
      {!isAdmin ? <p className="cw-muted">Only administrators can publish or retire waivers.</p> : null}

      {publishing ? (
        <PublishPanel
          waiver={publishing.waiver}
          activeMembers={activeMembers}
          onClose={() => setPublishing(null)}
          onPublished={() => {
            setPublishing(null);
            refresh();
          }}
        />
      ) : null}
      {retiring ? (
        <RetireDialog
          policy={retiring}
          onClose={() => setRetiring(null)}
          onRetired={() => {
            setRetiring(null);
            refresh();
          }}
        />
      ) : null}
      {reading ? (
        <Modal open width="regular" title={`${reading.name} · ${reading.version}`} onClose={() => setReading(null)}>
          <p className="policy-text">{reading.description}</p>
        </Modal>
      ) : null}
    </section>
  );
}
