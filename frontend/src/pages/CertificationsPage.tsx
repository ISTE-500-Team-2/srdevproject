import { CheckCircle2, FileText, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import type { Certification, Waiver } from '../lib/contracts';
import { useApi } from '../lib/useApi';

export function CertificationsPage() {
  const waivers = useApi<Waiver[]>('/me/waivers');
  const certifications = useApi<Certification[]>('/me/certifications');
  const [selected, setSelected] = useState<Waiver | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const sign = async () => {
    if (!selected || !accepted) return;
    setBusy(true);
    setError('');
    try {
      await api('/me/waivers/' + selected.id + '/sign', {
        method: 'POST',
        body: { accepted: true },
      });
      waivers.reload();
      setSelected(null);
      setToast('Your agreement has been recorded.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="credentials-page page-enter">
      <section>
        <p className="eyebrow">Your access records</p>
        <h1>Certifications & waivers</h1>
      </section>
      <section className="panel feature-notice">
        <h2>
          <ShieldCheck aria-hidden="true" /> Your certifications
        </h2>
        {certifications.loading ? (
          <p role="status">Loading certifications…</p>
        ) : null}
        {certifications.error ? (
          <p role="alert">
            {certifications.error}{' '}
            <button onClick={certifications.reload}>Retry</button>
          </p>
        ) : null}
        {!certifications.loading &&
        !certifications.error &&
        !certifications.data?.length ? (
          <p>No certifications have been recorded for your account.</p>
        ) : null}
        <div className="saved-records">
          {certifications.data?.map((item) => (
            <article className="saved-record" key={item.id}>
              <div>
                <h3>{item.name}</h3>
                <p>
                  {item.valid ? 'Current' : 'Not current'} · {item.status}
                </p>
                {item.renewalDate ? (
                  <p>
                    Renewal: {new Date(item.renewalDate).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="panel feature-notice">
        <h2>
          <FileText aria-hidden="true" /> Required policies & waivers
        </h2>
        {waivers.loading ? <p role="status">Loading policies…</p> : null}
        {waivers.error ? (
          <p role="alert">
            {waivers.error} <button onClick={waivers.reload}>Retry</button>
          </p>
        ) : null}
        {!waivers.loading && !waivers.error && !waivers.data?.length ? (
          <p>Required policies have not been configured yet.</p>
        ) : null}
        <div className="saved-records">
          {waivers.data?.map((item) => (
            <article className="saved-record" key={item.id}>
              <div>
                <h3>{item.name}</h3>
                <p>Version {item.version}</p>
                {item.signed ? (
                  <p>
                    <CheckCircle2 aria-hidden="true" /> Signed{' '}
                    {item.signedAt
                      ? new Date(item.signedAt).toLocaleString()
                      : ''}
                  </p>
                ) : (
                  <p>Signature required</p>
                )}
              </div>
              <button
                className="button button--quiet"
                onClick={() => {
                  setSelected(item);
                  setAccepted(false);
                  setError('');
                }}
              >
                {item.signed ? 'View policy' : 'Review and agree'}
              </button>
            </article>
          ))}
        </div>
      </section>
      <p>
        Training registration is not available yet.{' '}
        <Link to="/classes">View the class-catalog preview</Link>.
      </p>
      <Modal
        open={!!selected}
        title={selected?.name ?? 'Review policy'}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        {selected ? (
          <div className="stack-form">
            <p>Version {selected.version}</p>
            <p className="policy-text">
              {selected.description || 'Policy content has not been provided.'}
            </p>
            {!selected.signed ? (
              <>
                <label className="check-control">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />
                  <span aria-hidden="true" />I have read and agree to this
                  version of the policy.
                </label>
                {error ? (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                ) : null}
                <button
                  className="button button--primary"
                  disabled={!accepted || busy || !selected.description}
                  onClick={() => void sign()}
                >
                  {busy ? 'Saving…' : 'Record agreement'}
                </button>
              </>
            ) : (
              <p>This version is already signed.</p>
            )}
          </div>
        ) : null}
      </Modal>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
