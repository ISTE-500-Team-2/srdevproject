import { Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Modal } from "../Modal";
import { api, ApiError, errorMessage } from "../../lib/api";
import { shortDate, timeOnly } from "../../lib/display";
import type { ClassRecord } from "./classData";

export function CancelClassDialog({
  c,
  reason,
  onReason,
  onClose,
  onCancelled,
  onStale,
}: {
  c: ClassRecord;
  reason: string;
  onReason: (reason: string) => void;
  onClose: () => void;
  onCancelled: () => void;
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/classes/${c.id}/cancel`, {
        method: "POST",
        body: { expectedRevision: c.revision, reason: reason.trim() },
      });
      onCancelled();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_RECORD") {
        setError("This class changed since you opened it. Its details are refreshed. Check them, then cancel again.");
        onStale();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open width="compact" title={`Cancel ${c.title}?`} onClose={onClose}>
      <form className="class-form" onSubmit={(e) => void submit(e)}>
        <p className="class-detail__muted">
          {shortDate(c.startsAt)} · {timeOnly(c.startsAt)} · {c.roomName}
        </p>
        {c.enrolled ? (
          <p className="class-banner class-banner--error">
            <Users aria-hidden="true" />
            <span>
              <b>
                {c.enrolled} {c.enrolled === 1 ? "person is" : "people are"} registered.
              </b>{" "}
              They'll see it as cancelled on their Classes page, but <b>no one is emailed</b>, so let them know yourself.
            </span>
          </p>
        ) : null}
        <label className="class-field">
          <span>
            Reason <em>· required, staff-only</em>
          </span>
          <input
            value={reason}
            required
            maxLength={500}
            disabled={busy}
            placeholder="e.g. Instructor out sick"
            onChange={(e) => onReason(e.target.value)}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="class-dialog-actions">
          <span />
          <button type="button" className="button button--quiet" onClick={onClose}>
            Keep class
          </button>
          <button className="button button--danger" disabled={busy || !reason.trim()}>
            {busy ? "Cancelling…" : "Cancel class"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
