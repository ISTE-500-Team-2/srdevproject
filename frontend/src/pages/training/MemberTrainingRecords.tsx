import { Check } from "lucide-react";
import { LoadState } from "../../components/Management";
import { MemberSelect } from "../../components/MemberSelect";
import { shortDate } from "../../lib/display";
import type { Course, Loaded, TrainingRecord, TrainingTarget } from "./trainingTypes";

/** Looks a member up and lists their training, with renew, record and revoke actions. */
export function MemberTrainingRecords({
  memberId,
  onMember,
  records,
  catalog,
  canApprove,
  canConfigure,
  onRecord,
  onRevoke,
}: {
  memberId: string;
  onMember: (id: string) => void;
  records: Loaded<TrainingRecord[]>;
  catalog: Course[] | null;
  canApprove: boolean;
  canConfigure: boolean;
  onRecord: (target: TrainingTarget) => void;
  onRevoke: (record: TrainingRecord) => void;
}) {
  const current = memberId ? records.data ?? [] : [];
  const untrained = (catalog ?? []).filter((c) => !current.some((r) => r.certificationId === c.id));
  return (
    <section className="cw-records" aria-labelledby="records-title">
      <div className="cw-row">
        <h3 id="records-title">Member training records</h3>
      </div>
      <MemberSelect value={memberId} onChange={onMember} />
      {memberId ? (
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
                    {r.trainingMinutes ? ` · ${r.trainingMinutes} minutes verified` : ''}
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
                    <button type="button" className="button button--quiet cw-small" onClick={() => onRecord(r)}>
                      {r.valid ? "Renew" : "Record new training"}
                    </button>
                  ) : null}
                  {canConfigure && r.status === "active" ? (
                    <button type="button" className="button cw-danger cw-small" onClick={() => onRevoke(r)}>
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
                          aria-label={`Record ${c.name} training`}
                          onClick={() => onRecord({ certificationId: c.id, name: c.name })}
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
  );
}
