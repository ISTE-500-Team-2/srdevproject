import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import type { Policy } from "../lib/staffContracts";
import { ActionForm, Field, LoadState, ReasonField } from "../components/Management";
import { dateTime, localInput } from "../lib/display";

export function StaffPolicies() {
  const policies = useApi<Policy[]>("/admin/policies"),
    { user } = useAuth();
  const isAdmin = user?.roles.includes("admin"),
    [revision, setRevision] = useState(0);
  const saved = () => {
    policies.reload();
    setRevision((v) => v + 1);
  };
  return (
    <section className="management-grid">
      <div>
        <h2>Policies and waiver versions</h2>
        <p>
          Publishing a new version asks members to sign again once it takes effect. Past signatures are kept.
        </p>
        <LoadState {...policies} />
        <div className="management-records">
          {policies.data?.map((p) => (
            <article className="management-record" key={p.id}>
              <h3>
                {p.name} · {p.version}
              </h3>
              <p>
                {p.active ? "Active" : "Retired"} · Effective{" "}
                {dateTime(p.effectiveAt)}
              </p>
              <p>
                Source:{" "}
                {p.approvalReference ||
                  "No sponsor approval reference recorded; verify before use."}
              </p>
              <details>
                <summary>Read policy text</summary>
                <p className="policy-text">{p.description}</p>
              </details>
              {isAdmin && p.active ? (
                <details>
                  <summary>Retire this version</summary>
                  <ActionForm
                    title={`Retire ${p.name} ${p.version}`}
                    submitLabel="Retire version"
                    onSubmit={async (f) => {
                      await api(`/admin/policies/${p.id}/retire`, {
                        method: "POST",
                        body: { reason: f.get("reason") },
                      });
                      saved();
                    }}
                  >
                    <p>
                      Retiring every required policy blocks check-in until a
                      current policy is configured. Superseded versions remain
                      retired; this does not restore an older agreement.
                    </p>
                    <ReasonField />
                  </ActionForm>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      </div>
      {isAdmin ? (
        <div className="panel management-panel">
          <ActionForm
            key={revision}
            title="Publish Policy/Waiver Version"
            submitLabel="Publish Version"
            onSubmit={async (f) => {
              await api("/admin/policies", {
                method: "POST",
                body: {
                  name: f.get("name"),
                  version: f.get("version"),
                  description: f.get("description"),
                  effectiveAt: new Date(
                    String(f.get("effectiveAt")),
                  ).toISOString(),
                  approvalReference: f.get("approvalReference"),
                  reason: f.get("reason"),
                },
              });
              saved();
            }}
          >
            <p>
              Paste the approved wording and note where it came from.
            </p>
            <Field
              label="Policy name (reuse for a replacement version)"
              name="name"
              maxLength={100}
            />
            <Field label="Version" name="version" maxLength={50} />
            <Field label="Policy text" name="description">
              <textarea
                name="description"
                required
                minLength={20}
                maxLength={16000}
                rows={12}
                placeholder="Include the body of the waiver/policy"
              />
            </Field>
            <Field
              label="Effective date/time (your local timezone)"
              name="effectiveAt"
              type="datetime-local"
              defaultValue={localInput()}
            />
            <Field
              label="Approval/source reference"
              name="approvalReference"
              maxLength={500}
            />
            <ReasonField />
          </ActionForm>
        </div>
      ) : (
        <p>Only administrators can publish or retire policy versions.</p>
      )}
    </section>
  );
}
