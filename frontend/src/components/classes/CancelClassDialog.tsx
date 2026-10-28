import { Users, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Modal } from "../Modal";
import { api, ApiError, errorMessage } from "../../lib/api";
import { shortDate, timeOnly } from "../../lib/display";
import type { ClassRecord } from "./classData";
import HoldButton from "../reactbits/HoldButton";

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
  const form = useRef<HTMLFormElement>(null);
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
      <form ref={form} className="class-form" onSubmit={(e) => void submit(e)}>
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
          {/* Cancelling can't be undone, so it takes a deliberate hold. The
              hold submits the form, which keeps the required-reason check. */}
          <HoldButton
            className="site-hold-button"
            disabled={busy || !reason.trim()}
            holdTime={1200}
            radius={9}
            backgroundColor="#fff5f3"
            fillColor="#b73a2e"
            textColor="#b73a2e"
            fillTextColor="#ffffff"
            icon={<X size={16} aria-hidden="true" />}
            doneLabel={busy ? "Cancelling…" : "Cancelled"}
            onHold={() => form.current?.requestSubmit()}
          >
            Hold to cancel class
          </HoldButton>
        </div>
      </form>
    </Modal>
  );
}
