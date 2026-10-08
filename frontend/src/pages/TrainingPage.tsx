import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { useApi } from "../lib/useApi";
import { LoadState } from "../components/Management";
type Course = {
  id: number;
  name: string;
  description: string;
  validityDays: number | null;
  revision: number;
  equipmentIds: number[];
};
type Record = {
  id: number;
  certificationId: number;
  name: string;
  status: string;
  valid: boolean;
  revision: number;
  expiresAt: string | null;
  trainedAt: string | null;
  instructorName: string | null;
};
export function TrainingPage() {
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
    />
  );
}
function TrainingWorkspace({
  canConfigure,
  canApprove,
}: {
  canConfigure: boolean;
  canApprove: boolean;
}) {
  const catalog = useApi<Course[]>("/training/catalog");
  const [memberId, setMemberId] = useState("");
  const [selectedMember, setSelectedMember] = useState("");
  const records = useApi<Record[]>(
    selectedMember ? `/training/users/${selectedMember}` : null,
  );
  const [editing, setEditing] = useState<Course | null>(null);
  const [renewing, setRenewing] = useState<Record | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      catalog.reload();
      if (selectedMember) records.reload();
      setMessage("Training records saved.");
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveCourse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(
        editing ? `/training/catalog/${editing.id}` : "/training/catalog",
        {
          method: editing ? "PATCH" : "POST",
          body: {
            name: f.get("name"),
            description: f.get("description"),
            validityDays: Number(f.get("days")),
            equipmentIds: String(f.get("equipmentIds") ?? "")
              .split(",")
              .filter((x) => x.trim())
              .map(Number),
            reason: f.get("reason"),
            ...(editing ? { expectedRevision: editing.revision } : {}),
          },
        },
      );
      setEditing(null);
    });
  }
  async function approve(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(
        `/training/users/${selectedMember}/certifications/${f.get("certId")}`,
        {
          method: "POST",
          body: {
            trainedAt: new Date(String(f.get("trainedAt"))).toISOString(),
            source: f.get("source"),
            verifiedInPerson: f.get("verified") === "on",
            verificationReference: f.get("reference"),
            reason: f.get("reason"),
            ...(records.data?.find(
              (r) => r.certificationId === Number(f.get("certId")),
            )
              ? {
                  expectedRevision: records.data!.find(
                    (r) => r.certificationId === Number(f.get("certId")),
                  )!.revision,
                }
              : {}),
          },
        },
      );
      setRenewing(null);
    });
  }
  return (
    <div className="management-page page-enter">
      <p className="eyebrow">Equipment safety</p>
      <h1>Training & certification management</h1>
      <p>
        Record completed in-person training, maintain approved validity periods,
        and revoke qualifications when retraining is required.
      </p>
      {message ? (
        <p role="status" className="form-notice">
          {message}
        </p>
      ) : null}
      <div className="management-grid">
        <section>
          <h2>Certification catalog</h2>
          <LoadState {...catalog} />
          {catalog.data?.map((c) => (
            <article className="saved-record" key={c.id}>
              <h3>{c.name}</h3>
              <p>
                {c.validityDays
                  ? `${c.validityDays} days validity`
                  : "Validity not configured"}{" "}
                · Equipment: {c.equipmentIds.join(", ") || "None linked"}
              </p>
              {canConfigure ? (
                <button
                  className="button button--quiet"
                  onClick={() => setEditing(c)}
                >
                  Configure {c.name}
                </button>
              ) : null}
            </article>
          ))}
          {canConfigure ? (
            <form
              className="management-form"
              key={editing?.id ?? "new"}
              onSubmit={saveCourse}
            >
              <h3>{editing ? "Edit certification" : "New certification"}</h3>
              <label>
                Name
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={editing?.name}
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  maxLength={255}
                  defaultValue={editing?.description}
                />
              </label>
              <label>
                Approved validity in days
                <input
                  name="days"
                  type="number"
                  min={1}
                  max={3650}
                  required
                  defaultValue={editing?.validityDays ?? ""}
                />
              </label>
              <label>
                Equipment IDs (comma separated)
                <input
                  name="equipmentIds"
                  defaultValue={editing?.equipmentIds.join(", ")}
                />
              </label>
              <label>
                Policy approval/reference
                <input name="reason" required maxLength={500} />
              </label>
              <button className="button" disabled={busy}>
                Save certification
              </button>
              {editing ? (
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => setEditing(null)}
                >
                  Cancel editing
                </button>
              ) : null}
            </form>
          ) : null}
        </section>
        <section>
          <h2>Member training records</h2>
          <form
            className="management-search"
            onSubmit={(e) => {
              e.preventDefault();
              setSelectedMember(memberId);
              setRenewing(null);
            }}
          >
            <label>
              Member ID
              <input
                type="number"
                min={1}
                required
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              />
            </label>
            <button className="button button--quiet">Load member</button>
          </form>
          {selectedMember ? (
            <>
              <LoadState {...records} />
              {records.data?.map((r) => (
                <article className="saved-record" key={r.id}>
                  <h3>{r.name}</h3>
                  <p>
                    {r.valid ? "Current" : "Not current"} · {r.status}
                  </p>
                  <p>
                    Trained:{" "}
                    {r.trainedAt
                      ? new Date(r.trainedAt).toLocaleDateString()
                      : "Legacy record: not recorded"}
                  </p>
                  <p>
                    Approved by:{" "}
                    {r.instructorName ?? "Legacy record: not recorded"}
                  </p>
                  <p>
                    Expires:{" "}
                    {r.expiresAt
                      ? new Date(r.expiresAt).toLocaleDateString()
                      : "Not recorded"}
                  </p>
                  {canApprove ? (
                    <button
                      className="button button--quiet"
                      onClick={() => setRenewing(r)}
                    >
                      Record new training for {r.name}
                    </button>
                  ) : null}
                  {canConfigure && r.status === "active" ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void run(() =>
                          api(
                            `/training/users/${selectedMember}/certifications/${r.certificationId}/revoke`,
                            {
                              method: "POST",
                              body: {
                                expectedRevision: r.revision,
                                reason: f.get("reason"),
                              },
                            },
                          ),
                        );
                      }}
                    >
                      <label>
                        Revocation/retraining reason
                        <input name="reason" required maxLength={500} />
                      </label>
                      <button className="button button--quiet" disabled={busy}>
                        Revoke {r.name}
                      </button>
                    </form>
                  ) : null}
                </article>
              ))}
              {canApprove ? (
                <form
                  className="management-form"
                  key={renewing?.id ?? selectedMember}
                  onSubmit={approve}
                >
                  <h3>
                    {renewing
                      ? "Record new completed training"
                      : "Approve completed training"}
                  </h3>
                  <label>
                    Certification
                    <select
                      name="certId"
                      required
                      defaultValue={renewing?.certificationId ?? ""}
                      onChange={() => setRenewing(null)}
                    >
                      <option value="">Choose a certification</option>
                      {catalog.data?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Actual training date/time
                    <input name="trainedAt" type="datetime-local" required />
                  </label>
                  <label>
                    Training source
                    <select name="source">
                      <option value="equipment">Equipment training</option>
                      <option value="external">
                        External training verified in person
                      </option>
                    </select>
                  </label>
                  <label>
                    Verification reference
                    <input name="reference" required maxLength={500} />
                  </label>
                  <label>
                    Reason
                    <input name="reason" required maxLength={500} />
                  </label>
                  <label>
                    <input name="verified" type="checkbox" required /> I
                    conducted or verified this training in person.
                  </label>
                  <p>
                    Approval records your signed-in identity. Self-certification
                    is not permitted.
                  </p>
                  <button className="button" disabled={busy}>
                    Approve training
                  </button>
                  {renewing ? (
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => setRenewing(null)}
                    >
                      Cancel renewal
                    </button>
                  ) : null}
                </form>
              ) : (
                <p>
                  An authorized instructor must verify and approve completed
                  training.
                </p>
              )}
            </>
          ) : (
            <p>Load a member to view their training history.</p>
          )}
        </section>
      </div>
    </div>
  );
}
