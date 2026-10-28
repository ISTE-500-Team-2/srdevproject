import { AlertTriangle, ArrowRight, CalendarDays, Check, MapPin, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../Modal";
import { api, errorMessage } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { shortDate } from "../../lib/display";
import { enrollmentLabel, hasStarted, isCancelled, timeRange, type AttendanceDraft, type ClassRecord, type RosterPerson } from "./classData";

type Outcome = "attended" | "no_show";
type SaveResult = { saved: { name: string; status: Outcome }[]; failed: number };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function RosterPanel({
  c,
  canRecord,
  draft,
  refreshToken,
  onDraft,
  onSaved,
  onClose,
}: {
  c: ClassRecord;
  /** Only the assigned instructor or an admin may record attendance. */
  canRecord: boolean;
  draft: AttendanceDraft;
  refreshToken: number;
  onDraft: (draft: AttendanceDraft) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const roster = useApi<RosterPerson[]>(`/classes/${c.id}/roster`, { retainOnReload: true });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [noteError, setNoteError] = useState("");
  const [result, setResult] = useState<SaveResult | null>(null);
  const reloadRoster = roster.reload;
  useEffect(() => {
    if (refreshToken) reloadRoster();
  }, [refreshToken, reloadRoster]);

  const started = hasStarted(c);
  const editable = canRecord && started && !isCancelled(c);
  const people = roster.data ?? [];
  const active = people.filter((p) => p.status !== "cancelled");
  const withdrew = people.filter((p) => p.status === "cancelled");
  const choice = (p: RosterPerson): Outcome | null =>
    draft.statuses[p.userId] ?? (p.status === "attended" || p.status === "no_show" ? p.status : null);
  const changes = active.filter((p) => draft.statuses[p.userId] && draft.statuses[p.userId] !== p.status);
  const unmarked = active.filter((p) => !choice(p)).length;

  function choose(p: RosterPerson, status: Outcome) {
    const statuses = { ...draft.statuses };
    if (status === p.status) delete statuses[p.userId];
    else statuses[p.userId] = status;
    onDraft({ ...draft, statuses });
    setResult(null);
  }

  async function save() {
    if (!draft.note.trim()) {
      setNoteError("Add a verification note. It's saved with each record.");
      return;
    }
    setNoteError("");
    setSaving(true);
    const nextErrors: Record<number, string> = {};
    const saved: SaveResult["saved"] = [];
    const statuses = { ...draft.statuses };
    // One request per person: the API records attendance individually, so a
    // failure leaves that person's choice in place to retry.
    for (const p of changes) {
      const status = statuses[p.userId];
      try {
        await api(`/classes/${c.id}/attendance`, {
          method: "POST",
          body: { userId: p.userId, status, reason: draft.note.trim() },
        });
        saved.push({ name: p.name, status });
        delete statuses[p.userId];
      } catch (error) {
        nextErrors[p.userId] = errorMessage(error);
      }
    }
    const failed = Object.keys(nextErrors).length;
    onDraft({ statuses, note: failed ? draft.note : "" });
    setErrors(nextErrors);
    setResult({ saved, failed });
    setSaving(false);
    roster.reload();
    onSaved();
  }

  return (
    <Modal open width="panel" title={c.title} onClose={onClose}>
      <section className="roster" role="region" aria-label={`${c.title} roster`}>
        <p className="class-meta">
          <span>
            <CalendarDays aria-hidden="true" />
            {shortDate(c.startsAt)} · {timeRange(c)}
          </span>
          <span>
            <MapPin aria-hidden="true" />
            {c.roomName}
          </span>
          <span>
            <UserRound aria-hidden="true" />
            {c.instructor}
          </span>
        </p>
        {roster.loading ? <p role="status">Loading roster…</p> : null}
        {roster.error ? (
          <p className="form-error" role="alert">
            {roster.error}
          </p>
        ) : null}
        {roster.data ? (
          <>
            <div className="roster__heading">
              <h3>{active.length} on the roster</h3>
              {editable && active.length ? <span>Nobody is marked until you choose</span> : null}
            </div>
            {!active.length ? <p className="class-detail__muted">Nobody is registered.</p> : null}
            <ul className="roster__people">
              {active.map((p) => {
                const value = choice(p);
                const changed = Boolean(draft.statuses[p.userId] && draft.statuses[p.userId] !== p.status);
                return (
                  <li key={p.userId} className={errors[p.userId] ? "roster__person roster__person--error" : "roster__person"}>
                    <span className="roster__avatar" aria-hidden="true">
                      {initials(p.name)}
                    </span>
                    <div>
                      <b>{p.name}</b>
                      <span>{p.email}</span>
                    </div>
                    {editable ? (
                      <fieldset className="attendance-toggle" disabled={saving}>
                        <legend className="sr-only">Attendance for {p.name}</legend>
                        <label className={value === "attended" ? "is-attended" : ""}>
                          <input
                            type="radio"
                            name={`attendance-${c.id}-${p.userId}`}
                            checked={value === "attended"}
                            onChange={() => choose(p, "attended")}
                          />
                          {value === "attended" ? <Check aria-hidden="true" /> : null}
                          Attended
                        </label>
                        <label className={value === "no_show" ? "is-no-show" : ""}>
                          <input
                            type="radio"
                            name={`attendance-${c.id}-${p.userId}`}
                            checked={value === "no_show"}
                            onChange={() => choose(p, "no_show")}
                          />
                          {value === "no_show" ? <X aria-hidden="true" /> : null}
                          No show
                        </label>
                      </fieldset>
                    ) : (
                      <span className="status-pill status-pill--neutral">{enrollmentLabel(p.status)}</span>
                    )}
                    {changed ? <small className="roster__changed">Unsaved</small> : null}
                    {errors[p.userId] ? (
                      <p className="roster__error" role="alert">
                        <AlertTriangle aria-hidden="true" />
                        {p.name} didn't save: {errors[p.userId]}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {withdrew.length ? (
              <p className="class-detail__muted">Withdrew: {withdrew.map((p) => p.name).join(", ")}</p>
            ) : null}
            {editable && active.length ? (
              <label className="class-field">
                <span>
                  Verification note <em>· required, saved with each record</em>
                </span>
                <input
                  value={draft.note}
                  maxLength={500}
                  disabled={saving}
                  placeholder="e.g. Checked against the instructor's sign-in sheet"
                  aria-invalid={Boolean(noteError)}
                  onChange={(e) => {
                    onDraft({ ...draft, note: e.target.value });
                    setNoteError("");
                  }}
                />
                {noteError ? <small className="class-field__error">{noteError}</small> : null}
              </label>
            ) : null}
            {!started && !isCancelled(c) ? (
              <p className="class-detail__muted">Attendance can be recorded once the class starts.</p>
            ) : started && !canRecord && !isCancelled(c) ? (
              <p className="class-detail__muted">The assigned instructor or an admin records attendance for this class.</p>
            ) : null}
            {result ? (
              <div className={`roster__result${result.failed ? " roster__result--partial" : ""}`} role="status">
                <b>
                  Saved {result.saved.length} of {result.saved.length + result.failed}{" "}
                  {result.saved.length + result.failed === 1 ? "change" : "changes"}
                </b>
                {result.saved.length ? (
                  <span>
                    {result.saved.map((s) => `${s.name} ${s.status === "attended" ? "attended" : "no show"}`).join(" · ")}
                  </span>
                ) : null}
                {result.failed ? <span>Choices that didn't save are kept. Check the roster, then save again.</span> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      <div className="class-dialog-actions class-dialog-actions--panel">
        {editable && active.length ? (
          <span>
            <b>{changes.length} {changes.length === 1 ? "change" : "changes"} ready</b>
            {unmarked ? ` · ${unmarked} still unmarked` : ""}
          </span>
        ) : (
          <span />
        )}
        <Link className="button button--quiet" to="/training">
          Open Training
          <ArrowRight aria-hidden="true" />
        </Link>
        {editable && active.length ? (
          <button type="button" className="button button--primary" disabled={saving || !changes.length} onClick={() => void save()}>
            <Check aria-hidden="true" />
            {saving ? "Saving…" : changes.length ? `Save ${changes.length} ${changes.length === 1 ? "change" : "changes"}` : "Save changes"}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
