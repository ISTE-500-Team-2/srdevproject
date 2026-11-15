import { useState } from "react";
import { Modal } from "../../components/Modal";
import HoldButton from "../../components/reactbits/HoldButton";
import { api } from "../../lib/api";
import type { SaveOutcome, TrainingRecord } from "./trainingTypes";
import { useTrainingSave } from "./useTrainingSave";

/** Revokes an active training record; the member needs new in-person training afterwards. */
export function RevokeTrainingDialog({
  memberId,
  record,
  outcome,
  onClose,
}: {
  memberId: string;
  record: TrainingRecord;
  outcome: SaveOutcome;
  onClose: () => void;
}) {
  const { busy, error, save } = useTrainingSave(outcome);
  const [reason, setReason] = useState("");
  return (
    <Modal open width="compact" title={`Revoke ${record.name}?`} onClose={onClose}>
      <div className="cw-form">
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <p>The member loses access to linked equipment until new in-person training is recorded.</p>
        <label className="cw-field">
          <span>Revocation/retraining reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        </label>
        <div className="cw-form__actions">
          <button type="button" className="button button--quiet" onClick={onClose}>
            Keep it
          </button>
          <HoldButton
            className="site-hold-button"
            disabled={busy || !reason.trim()}
            holdTime={1200}
            radius={9}
            backgroundColor="var(--hold-danger-bg)"
            fillColor="var(--hold-danger)"
            textColor="var(--hold-danger-text)"
            fillTextColor="var(--hold-danger-ink)"
            doneLabel="Revoking…"
            onHold={() => {
              void save(() =>
                api(`/training/users/${memberId}/certifications/${record.certificationId}/revoke`, {
                  method: "POST",
                  body: { expectedRevision: record.revision, reason },
                }),
              ).then((saved) => {
                if (saved) onClose();
              });
            }}
          >
            Hold to revoke {record.name}
          </HoldButton>
        </div>
      </div>
    </Modal>
  );
}
