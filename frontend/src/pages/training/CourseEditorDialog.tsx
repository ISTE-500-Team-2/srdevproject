import { useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { LoadState } from "../../components/Management";
import { Modal } from "../../components/Modal";
import { api } from "../../lib/api";
import type { LiveEquipment } from "../../lib/contracts";
import type { CourseEditor, Loaded, SaveOutcome } from "./trainingTypes";
import { useTrainingSave } from "./useTrainingSave";

/** Creates a certification or edits one, including the equipment it covers. */
export function CourseEditorDialog({
  editor,
  equipment,
  outcome,
  onClose,
}: {
  editor: CourseEditor;
  equipment: Loaded<LiveEquipment[]>;
  outcome: SaveOutcome;
  onClose: () => void;
}) {
  const course = editor.mode === "edit" ? editor.course : null;
  const { busy, error, save } = useTrainingSave(outcome);
  const [equipmentSearch, setEquipmentSearch] = useState("");
  const [equipmentIds, setEquipmentIds] = useState<number[]>(course?.equipmentIds ?? []);
  const [dirty, setDirty] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await save(async () => {
      await api(course ? `/training/catalog/${course.id}` : "/training/catalog", {
        method: course ? "PATCH" : "POST",
        body: {
          name: f.get("name"),
          description: f.get("description"),
          trainingMinutes: Number(f.get("minutes")),
          trainingFeeCents: String(f.get("fee")).trim() ? Math.round(Number(f.get("fee")) * 100) : null,
          equipmentIds,
          reason: f.get("reason"),
          ...(course ? { expectedRevision: course.revision } : {}),
        },
      });
      onClose();
    });
  }
  return (
    <Modal open width="panel" title={course ? `Edit ${course.name}` : "New certification"} dirty={dirty} dismissible={!busy} onClose={onClose}>
      {(requestClose) => <form className="cw-form" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <label className="cw-field">
          <span>Name</span>
          <input name="name" required maxLength={100} defaultValue={course?.name} />
        </label>
        <label className="cw-field">
          <span>Description</span>
          <textarea name="description" maxLength={255} rows={3} defaultValue={course?.description} />
        </label>
        <div className="cw-field" role="group" aria-labelledby="certification-renewal">
          <span id="certification-renewal">Renewal</span>
          <p className="cw-fact"><RefreshCw aria-hidden="true" /><span><b>1 year</b> from each member’s training date</span></p>
          <small>Training can still be revoked.</small>
        </div>
        <div className="cw-two">
          <label className="cw-field"><span>Training duration (minutes)</span><input name="minutes" type="number" min={1} max={480} required defaultValue={course?.trainingMinutes ?? 60} /></label>
          <label className="cw-field"><span>One-time training fee ($)</span><input name="fee" type="number" min={0} max={100000} step="0.01" defaultValue={course?.trainingFeeCents == null ? '' : (course.trainingFeeCents/100).toFixed(2)} /></label>
        </div>
        <p className="cw-muted">This is the total price of the training session, paid once per equipment certification. There is no extra course fee. Previously paid or completed training is not charged again. Equipment bookings only charge the hourly rate. Enter 0 for no training fee; leave blank to pause new training registration until priced.</p>
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
                    disabled={!!course?.equipmentIds.includes(item.id) || !!(item.certification && item.certification !== course?.name)}
                    onChange={(e) =>
                      setEquipmentIds((ids) => (e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id)))
                    }
                  />{" "}
                  {item.name} — {item.location}
                </label>
              ))}
          </div>
          <small>
            {equipmentIds.length} selected. Each machine can require one certification. Equipment linked to another
            certification cannot be reassigned here. Existing links are kept and cannot be unchecked.
          </small>
        </fieldset>
        <label className="cw-field">
          <span>Policy approval/reference</span>
          <input name="reason" required maxLength={500} />
        </label>
        <div className="cw-form__actions">
          <button type="button" className="button button--quiet" onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy || equipment.loading || !!equipment.error}>
            Save certification
          </button>
        </div>
      </form>}
    </Modal>
  );
}
