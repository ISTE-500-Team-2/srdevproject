import { Download, FileText, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../lib/api";
import type { SignedWaiver } from "../../lib/billingContracts";
import { shortDate } from "../../lib/display";
import { useApi } from "../../lib/useApi";
import { Section } from "../profileSections";

/** `adminOnly`: staff other than administrators can't open signed copies from a member's account. */
export function DocumentsSection({ adminOnly }: { adminOnly: boolean }) {
  const records = useApi<SignedWaiver[]>(adminOnly ? null : "/me/signed-waivers");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const download = async (id: number) => {
    setError("");
    setBusy(id);
    try {
      const copy = await api<{ fileName: string; content: string }>(`/me/signed-waivers/${id}/copy`);
      const url = URL.createObjectURL(new Blob([copy.content], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = copy.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section id="documents" title="Documents" note="Copies of the waivers you've signed." Icon={FileText}>
      {adminOnly ? <p className="account-hint">Only administrators can open signed waiver copies.</p> : null}
      {records.loading && !records.data ? <p role="status">Loading documents…</p> : null}
      {records.error ? <p className="form-error">{records.error}</p> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {records.data?.length === 0 ? (
        <p className="account-hint">
          Nothing signed yet. <Link to="/certifications">Review your waivers</Link>
        </p>
      ) : null}
      <ul className="account-docs">
        {records.data?.map((record) => (
          <li key={record.id}>
            <span className="account-docs__icon">
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <b>{record.name}</b>
              <p>
                {record.version} · signed {shortDate(record.signedAt, true)}
                {record.expiresAt ? ` · expires ${shortDate(record.expiresAt, true)}` : ""}
              </p>
            </div>
            {record.copyAvailable ? (
              <button
                type="button"
                className="button button--quiet"
                disabled={busy !== null}
                onClick={() => void download(record.id)}
                aria-label={`Download signed copy of ${record.name}`}
              >
                <Download aria-hidden="true" /> {busy === record.id ? "Preparing…" : "Copy"}
              </button>
            ) : (
              <span className="account-docs__none">Ask staff for this older record</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
