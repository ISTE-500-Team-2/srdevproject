import { useState } from "react";
import type { LiveEquipment } from "../lib/contracts";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useApi } from "../lib/useApi";
import type { ComplianceReport } from "../lib/staffContracts";
import { Plus } from "lucide-react";
import { CertificationCatalog } from "./training/CertificationCatalog";
import { CourseEditorDialog } from "./training/CourseEditorDialog";
import { MemberTrainingRecords } from "./training/MemberTrainingRecords";
import { RecordTrainingDialog } from "./training/RecordTrainingDialog";
import { RevokeTrainingDialog } from "./training/RevokeTrainingDialog";
import type { Course, CourseEditor, SaveOutcome, TrainingRecord, TrainingTarget } from "./training/trainingTypes";
import "./certwaiver.css";
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
/**
 * Training administration. Each workflow (certification editor, recording training,
 * revoking it) owns its busy and error state; the page only refreshes the shared reads
 * and confirms a save.
 */
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
  const [memberId, setMemberId] = useState("");
  const records = useApi<TrainingRecord[]>(memberId ? `/training/users/${memberId}` : null);
  const stats = useApi<ComplianceReport>(canConfigure ? "/admin/compliance?userStatus=active" : null);
  const [editor, setEditor] = useState<CourseEditor | null>(null);
  const [recording, setRecording] = useState<TrainingTarget | null>(null);
  const [revoking, setRevoking] = useState<TrainingRecord | null>(null);
  const [message, setMessage] = useState("");
  const outcome: SaveOutcome = {
    started: () => setMessage(""),
    saved: () => {
      catalog.reload();
      if (memberId) records.reload();
      setMessage("Training records saved.");
    },
  };

  return (
    <div className={embedded ? "cw-section" : "management-page page-enter cw-section"}>
      {embedded ? null : <h1>Training &amp; certifications</h1>}
      <div className="cw-row">
        <p className="cw-muted">Training members must complete before they can use linked equipment.</p>
        {canConfigure ? (
          <button type="button" className="button button--primary cw-small" onClick={() => setEditor({ mode: "new" })}>
            <Plus aria-hidden="true" /> New certification
          </button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="form-notice">
          {message}
        </p>
      ) : null}
      <CertificationCatalog
        catalog={catalog}
        equipment={equipment.data}
        compliance={stats.data}
        canConfigure={canConfigure}
        onEdit={(course) => setEditor({ mode: "edit", course })}
      />
      <MemberTrainingRecords
        memberId={memberId}
        onMember={(id) => {
          setMemberId(id);
          setRecording(null);
          setRevoking(null);
        }}
        records={records}
        catalog={catalog.data}
        canApprove={canApprove}
        canConfigure={canConfigure}
        onRecord={setRecording}
        onRevoke={setRevoking}
      />

      {editor ? (
        <CourseEditorDialog
          key={editor.mode === "edit" ? editor.course.id : "new"}
          editor={editor}
          equipment={equipment}
          outcome={outcome}
          onClose={() => setEditor(null)}
        />
      ) : null}

      {recording ? (
        <RecordTrainingDialog
          key={recording.certificationId}
          memberId={memberId}
          target={recording}
          records={records.data}
          minutes={catalog.data?.find((c) => c.id === recording.certificationId)?.trainingMinutes ?? 60}
          outcome={outcome}
          onClose={() => setRecording(null)}
        />
      ) : null}

      {revoking ? (
        <RevokeTrainingDialog key={revoking.id} memberId={memberId} record={revoking} outcome={outcome} onClose={() => setRevoking(null)} />
      ) : null}
    </div>
  );
}
