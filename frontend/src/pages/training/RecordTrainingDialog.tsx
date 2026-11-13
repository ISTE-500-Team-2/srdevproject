import type { FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { api } from "../../lib/api";
import { localInput } from "../../lib/display";
import type { SaveOutcome, TrainingRecord, TrainingTarget } from "./trainingTypes";
import { useTrainingSave } from "./useTrainingSave";

/** An instructor records a member's first training or a renewal, verified in person. */
export function RecordTrainingDialog({
  memberId,
  target,
  records,
  minutes,
  outcome,
  onClose,
}: {
  memberId: string;
  target: TrainingTarget;
  /** The member's current records; a renewal sends the revision it was based on. */
  records: TrainingRecord[] | null;
  /** The certification's required training minutes. */
  minutes: number;
  outcome: SaveOutcome;
  onClose: () => void;
}) {
  const { busy, error, save } = useTrainingSave(outcome);
  async function approve(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await save(async () => {
      const existing = records?.find((r) => r.certificationId === Number(f.get("certId")));
      await api(`/training/users/${memberId}/certifications/${f.get("certId")}`, {
        method: "POST",
        body: {
          trainedAt: new Date(String(f.get("trainedAt"))).toISOString(),
          trainingMinutes: Number(f.get("completedMinutes")),
          source: f.get("source"),
          verifiedInPerson: f.get("verified") === "on",
          verificationReference: f.get("reference"),
          reason: f.get("reason"),
          ...(existing ? { expectedRevision: existing.revision } : {}),
        },
      });
      onClose();
    });
  }
  return (
    <Modal open width="panel" title={`Record training: ${target.name}`} onClose={onClose}>
      <form className="cw-form" onSubmit={approve}>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <input type="hidden" name="certId" value={target.certificationId} />
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
        <label className="cw-field"><span>Completed training (minutes)</span><input name="completedMinutes" type="number" required min={minutes} max={480} defaultValue={minutes} /></label>
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
          <button type="button" className="button button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy}>
            Approve training
          </button>
        </div>
      </form>
    </Modal>
  );
}
