import { useState } from "react";
import { LoadState } from "../../components/Management";
import { Modal } from "../../components/Modal";
import { useAuth } from "../../context/AuthContext";
import { api, errorMessage } from "../../lib/api";
import { dateTime } from "../../lib/display";
import { useApi } from "../../lib/useApi";

interface ServiceNotice {
  id: number;
  source: "reader" | "staff";
  readerId: string | null;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
}

export function ServiceNotices() {
  const { user } = useAuth();
  const isAdmin = !!user?.roles.includes("admin");
  const notices = useApi<ServiceNotice[]>("/admin/service-notices");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [fixedNote, setFixedNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [resolving, setResolving] = useState<ServiceNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (path: string, body: object, done: () => void) => {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST", body });
      done();
      notices.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <p>
        Staff are emailed automatically when a card reader stops reporting in. Use a notice to tell
        everyone about any other problem, and again once it's fixed. An outage of this whole site
        can't send its own notice.
      </p>
      {isAdmin ? (
        <form
          className="management-search"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            setConfirming(true);
          }}
        >
          <label>
            What members should know
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={5} maxLength={500} />
          </label>
          <label>
            Reason for the change log
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
          </label>
          <button className="button button--quiet" disabled={busy}>Review notice</button>
        </form>
      ) : null}
      {error && !confirming && !resolving ? <p role="alert">{error}</p> : null}
      <LoadState {...notices} />
      <div className="management-records">
        {notices.data?.length ? (
          notices.data.map((notice) => (
            <article className="management-record" key={notice.id}>
              <div>
                <h3>{notice.summary}</h3>
                <span className="status-label">{notice.resolvedAt ? "Resolved" : "Open"}</span>
              </div>
              <p>
                Opened {dateTime(notice.openedAt)}
                {notice.resolvedAt ? ` · Resolved ${dateTime(notice.resolvedAt)}` : ""}
              </p>
              {!notice.resolvedAt && notice.source === "reader" ? (
                <p>This clears on its own when the reader reconnects.</p>
              ) : null}
              {!notice.resolvedAt && notice.source === "staff" && isAdmin ? (
                <button
                  className="button button--quiet"
                  aria-label={`Mark fixed: ${notice.summary}`}
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setFixedNote("");
                    setResolving(notice);
                  }}
                >
                  Mark fixed
                </button>
              ) : null}
            </article>
          ))
        ) : notices.data ? (
          <p>No service notices have been sent.</p>
        ) : null}
      </div>
      <Modal open={confirming} title="Email every member?" width="compact" dismissible={!busy} onClose={() => setConfirming(false)}>
        <p>This goes to every active account that hasn't opted out of notifications:</p>
        <blockquote>{summary}</blockquote>
        {error ? <p role="alert">{error}</p> : null}
        <div className="membership-dialog__actions">
          <button className="button button--quiet" disabled={busy} onClick={() => setConfirming(false)}>
            Keep editing
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() =>
              void send("/admin/service-notices", { summary, reason }, () => {
                setConfirming(false);
                setSummary("");
                setReason("");
              })
            }
          >
            Send to everyone
          </button>
        </div>
      </Modal>
      <Modal open={!!resolving} title="Tell everyone it's fixed?" width="compact" dismissible={!busy} onClose={() => setResolving(null)}>
        <label className="cw-field">
          <span>What was fixed</span>
          <input value={fixedNote} onChange={(e) => setFixedNote(e.target.value)} required maxLength={500} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className="membership-dialog__actions">
          <button className="button button--quiet" disabled={busy} onClick={() => setResolving(null)}>
            Not yet
          </button>
          <button
            className="button button--primary"
            disabled={busy || !fixedNote.trim()}
            onClick={() => void send(`/admin/service-notices/${resolving!.id}/resolve`, { reason: fixedNote }, () => setResolving(null))}
          >
            Send to everyone
          </button>
        </div>
      </Modal>
    </section>
  );
}
