import {
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileText,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import type { Certification, LiveEquipment, Waiver } from '../lib/contracts';
import { useApi } from '../lib/useApi';

export function CertificationsPage() {
  const { demoLogin, user } = useAuth();
  const isMemberDemo =
    demoLogin &&
    user?.role === 'member' &&
    user.email === 'demo.member@collaboratory.invalid';
  const waivers = useApi<Waiver[]>('/me/waivers');
  const certifications = useApi<Certification[]>('/me/certifications');
  const equipment = useApi<LiveEquipment[]>('/equipment');
  const upcomingTrainingEquipment =
    equipment.data?.filter(
      (item) => item.status.toLocaleLowerCase() === 'available',
    ) ?? [];
  const [selected, setSelected] = useState<Waiver | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [openTrainingGroups, setOpenTrainingGroups] = useState({
    available: false,
    upcoming: true,
    completed: false,
  });
  const [trainingFilter, setTrainingFilter] = useState<
    'all' | keyof typeof openTrainingGroups
  >('all');
  const toggleTrainingGroup = (group: keyof typeof openTrainingGroups) => {
    setOpenTrainingGroups((current) => ({
      ...current,
      [group]: !current[group],
    }));
  };
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
    <div
      className={`credentials-page page-enter${isMemberDemo ? ' credentials-page--member-demo' : ''}`}
    >
      <section>
        <p className="eyebrow">Your access records</p>
        <h1>Certifications & waivers</h1>
        {user?.roles.some(r=>['admin','staff','instructor'].includes(r))?<Link to="/training">Manage training records</Link>:null}
      </section>
      <section className="panel feature-notice">
        <h2 className="certifications-heading">
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
        {!isMemberDemo &&
        !certifications.loading &&
        !certifications.error &&
        !certifications.data?.length ? (
          <p>No certifications have been recorded for your account.</p>
        ) : null}
        {isMemberDemo ? (
          <div className="certifications-table-wrap">
            {equipment.loading ? (
              <p role="status">Loading equipment…</p>
            ) : null}
            {equipment.error ? (
              <p role="alert">
                {equipment.error}{' '}
                <button onClick={equipment.reload}>Retry</button>
              </p>
            ) : null}
            <table className="certifications-table">
              <thead>
                <tr>
                  <th scope="col">Equipment name</th>
                  <th scope="col">Completion status</th>
                  <th scope="col">Date completed</th>
                </tr>
              </thead>
              <tbody>
                {!equipment.loading &&
                !equipment.error &&
                !certifications.loading &&
                !certifications.error
                  ? equipment.data?.map((item) => {
                      const certification = item.certification
                        ? certifications.data?.find(
                            (record) =>
                              record.name.trim().toLocaleLowerCase() ===
                              item.certification?.trim().toLocaleLowerCase(),
                          )
                        : null;
                      const complete = certification?.valid ?? false;
                      return (
                        <tr key={item.id}>
                          <td>
                            <span className="certification-equipment-name">
                              {item.name}
                            </span>
                          </td>
                          <td>
                            {item.certification ? (
                              complete ? (
                                <span className="certification-status certification-status--complete">
                                  <Check aria-hidden="true" /> complete
                                </span>
                              ) : (
                                <span className="certification-status certification-status--incomplete">
                                  <X aria-hidden="true" /> incomplete
                                </span>
                              )
                            ) : (
                              <span className="certification-status certification-status--complete">
                                <Check aria-hidden="true" /> No completion
                                needed
                              </span>
                            )}
                          </td>
                          <td>
                            <span className="certification-date-placeholder certification-date-placeholder--muted">
                              MM/DD/YYYY
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  : null}
              </tbody>
            </table>
            {!equipment.loading &&
            !equipment.error &&
            !certifications.loading &&
            !certifications.error &&
            !equipment.data?.length ? (
              <p>No equipment has been listed for reservations.</p>
            ) : null}
          </div>
        ) : (
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
        )}
      </section>
      <section className="panel feature-notice">
        <h2 className="certifications-heading">
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
        {isMemberDemo ? (
          <div className="certifications-table-wrap">
            <table className="certifications-table">
              <thead>
                <tr>
                  <th scope="col">Waiver Name</th>
                  <th scope="col">Signed Status</th>
                  <th scope="col">Date Signed</th>
                </tr>
              </thead>
              <tbody>
                {waivers.data?.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="waiver-name-cell">
                        <span className="certification-equipment-name">
                          {item.name}
                        </span>
                        <button
                          className="button button--quiet"
                          onClick={() => {
                            setSelected(item);
                            setAccepted(false);
                            setError('');
                          }}
                        >
                          {item.signed
                            ? 'View policy'
                            : item.outdatedSignature
                              ? 'Review new version'
                              : 'Review and agree'}
                        </button>
                      </div>
                    </td>
                    <td>
                      {item.signed ? (
                        <span className="certification-status certification-status--complete">
                          <Check aria-hidden="true" /> signed
                        </span>
                      ) : (
                        <span className="certification-status certification-status--incomplete">
                          <X aria-hidden="true" /> not signed
                        </span>
                      )}
                    </td>
                    <td>
                      {item.signed && item.signedAt ? (
                        new Date(item.signedAt).toLocaleDateString()
                      ) : item.signed ? (
                        'Date unavailable'
                      ) : (
                        <span className="certification-date-placeholder certification-date-placeholder--muted">
                          MM/DD/YYYY
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="saved-records">
            {waivers.data?.map((item) => (
              <article className="saved-record" key={item.id}>
                <div>
                  <h3>{item.name}</h3>
                  <p>Version {item.version} · ID {item.versionId}</p>
                  {item.signed ? (
                    <p>
                      <CheckCircle2 aria-hidden="true" /> Signed{' '}
                      {item.signedAt
                        ? new Date(item.signedAt).toLocaleString()
                        : ''}
                    </p>
                  ) : item.expiredSignature ? (
                    <p>Your signature has expired. Review and sign again. Last signed: {item.signedVersion}.</p>
                  ) : item.outdatedSignature ? (
                    <p>
                      New version needs your signature. Last signed:{' '}
                      {item.signedVersion ?? 'earlier version'}.
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
                  {item.signed ? 'View policy' : item.outdatedSignature ? 'Review new version' : 'Review and agree'}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {isMemberDemo ? (
        <section className="panel feature-notice training-schedule">
          <div className="training-panel__heading">
            <h2 className="certifications-heading">Schedule Training</h2>
            <label className="training-schedule__filter">
              <span>Filter</span>
              <select
                aria-label="Filter training by status"
                value={trainingFilter}
                onChange={(event) =>
                  setTrainingFilter(
                    event.target.value as
                      | 'all'
                      | keyof typeof openTrainingGroups,
                  )
                }
              >
                <option value="all">All statuses</option>
                <option value="available">Available</option>
                <option value="upcoming">Upcoming</option>
                <option value="completed">Completed</option>
              </select>
            </label>
          </div>
          {trainingFilter === 'all' || trainingFilter === 'available' ? (
            <div className="training-group">
              <button
                className="training-group__toggle"
                aria-expanded={openTrainingGroups.available}
                onClick={() => toggleTrainingGroup('available')}
              >
                Available <ChevronDown aria-hidden="true" />
              </button>
              {openTrainingGroups.available ? (
                <div
                  className="training-group__content"
                  id="training-available"
                >
                  <p className="training-panel__empty">
                    No training sessions are currently available.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          {trainingFilter === 'all' || trainingFilter === 'upcoming' ? (
            <div className="training-group">
              <button
                className="training-group__toggle"
                aria-expanded={openTrainingGroups.upcoming}
                onClick={() => toggleTrainingGroup('upcoming')}
              >
                Upcoming <ChevronDown aria-hidden="true" />
              </button>
              {openTrainingGroups.upcoming ? (
                <div
                  className="training-group__content"
                  id="training-upcoming"
                >
                  {equipment.loading ? (
                    <p role="status">Loading equipment…</p>
                  ) : equipment.error ? (
                    <p role="alert">
                      {equipment.error}{' '}
                      <button onClick={equipment.reload}>Retry</button>
                    </p>
                  ) : upcomingTrainingEquipment.length ? (
                    upcomingTrainingEquipment.map((item) => (
                      <article className="training-card" key={item.id}>
                        <div className="training-card__top">
                          <h3>{item.name}</h3>
                          <strong>$20.00</strong>
                        </div>
                        <p className="training-card__duration">
                          <Clock3 aria-hidden="true" /> 1 hour session
                        </p>
                        <p>Training session details coming soon</p>
                      </article>
                    ))
                  ) : (
                    <p className="training-panel__empty">
                      No available equipment is listed.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {trainingFilter === 'all' || trainingFilter === 'completed' ? (
            <div className="training-group">
              <button
                className="training-group__toggle"
                aria-expanded={openTrainingGroups.completed}
                onClick={() => toggleTrainingGroup('completed')}
              >
                Completed <ChevronDown aria-hidden="true" />
              </button>
              {openTrainingGroups.completed ? (
                <div
                  className="training-group__content"
                  id="training-completed"
                >
                  <p className="training-panel__empty">
                    No completed training sessions have been recorded.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <p>
          Training registration is not available yet.{' '}
          <Link to="/classes">View the class-catalog preview</Link>.
        </p>
      )}
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
