import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  GraduationCap,
  Hourglass,
  MapPin,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ClassThumb } from '../components/classes/ClassBits';
import {
  byStart,
  hasStarted,
  isCancelled,
  seatText,
  seatsLeft,
  timeRange,
  type ClassRecord,
} from '../components/classes/classData';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { WaiverDocumentForm } from '../components/WaiverDocumentForm';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
import type { Certification, LiveEquipment, Waiver } from '../lib/contracts';
import { shortDate } from '../lib/display';
import { useApi } from '../lib/useApi';
import './classes.css';
import './certifications.css';

/** A certification counts as "expiring" this many days before its renewal date. */
const EXPIRING_DAYS = 30;
const DAY_MS = 86400000;

type CertState =
  | 'current'
  | 'expiring'
  | 'expired'
  | 'revoked'
  | 'inactive'
  | 'registered'
  | 'awaiting'
  | 'missing';

type CertItem = {
  key: string;
  name: string;
  record: Certification | null;
  state: CertState;
  equipment: LiveEquipment[];
  /** The next class for this certification: the one you're registered for, else the soonest. */
  next: ClassRecord | null;
  /** The latest past class you were registered for or attended. */
  trained: ClassRecord | null;
};

const norm = (value: string) => value.trim().toLocaleLowerCase();
const day = (value: string) => shortDate(value, true);

/**
 * Joins your certification records, the equipment that needs them and the
 * scheduled training classes into one list. Records match classes by id;
 * equipment only carries the certification name.
 */
function certificationItems(
  records: Certification[],
  equipment: LiveEquipment[],
  classes: ClassRecord[],
  now = Date.now(),
): CertItem[] {
  const entries = new Map<string, { name: string; id: number | null; record: Certification | null }>();
  for (const record of records) entries.set(norm(record.name), { name: record.name, id: record.id, record });
  for (const item of equipment)
    if (item.certification && !entries.has(norm(item.certification)))
      entries.set(norm(item.certification), { name: item.certification, id: null, record: null });
  for (const c of classes)
    if (c.certificationId !== null && !isCancelled(c) && !hasStarted(c, now) && !entries.has(norm(c.certificationName)))
      entries.set(norm(c.certificationName), { name: c.certificationName, id: c.certificationId, record: null });

  return [...entries].map(([key, { name, id, record }]) => {
    const matches = classes.filter(
      (c) => c.certificationId !== null && (c.certificationId === id || norm(c.certificationName) === key),
    );
    const upcoming = matches.filter((c) => !isCancelled(c) && !hasStarted(c, now)).sort(byStart);
    const registered = upcoming.find((c) => c.myStatus === 'enrolled') ?? null;
    const approvedAt = record ? new Date(record.approvedAt ?? record.trainedAt ?? 0).getTime() : 0;
    const trained =
      matches
        .filter(
          (c) =>
            !isCancelled(c) &&
            hasStarted(c, now) &&
            (c.myStatus === 'attended' || c.myStatus === 'enrolled') &&
            new Date(c.startsAt).getTime() > approvedAt,
        )
        .sort((a, b) => byStart(b, a))[0] ?? null;
    const renewal = record?.renewalDate ? new Date(record.renewalDate).getTime() : null;
    const state: CertState = record?.valid
      ? renewal !== null && renewal - now <= EXPIRING_DAYS * DAY_MS
        ? 'expiring'
        : 'current'
      : trained
        ? 'awaiting'
        : registered
          ? 'registered'
          : record?.status === 'revoked'
            ? 'revoked'
            : record && renewal !== null && renewal < now
              ? 'expired'
              : record
                ? 'inactive'
                : 'missing';
    return {
      key,
      name,
      record,
      state,
      equipment: equipment.filter(
        (item) =>
          (item.certification && norm(item.certification) === key) || !!record?.equipmentIds?.includes(item.id),
      ),
      next: registered ?? upcoming[0] ?? null,
      trained,
    };
  });
}

/** Problems first, then training in progress, then certifications in good standing. */
const heldRank: Record<CertState, number> = {
  expired: 0, revoked: 0, inactive: 0, expiring: 1, awaiting: 2, registered: 2, current: 3, missing: 4,
};
const byHeld = (a: CertItem, b: CertItem) => heldRank[a.state] - heldRank[b.state] || a.name.localeCompare(b.name);
/** Training you're already in, then the soonest class, then certifications with nothing scheduled. */
const byNextStep = (a: CertItem, b: CertItem) => {
  const rank = (item: CertItem) => (item.state === 'missing' ? (item.next ? 1 : 2) : 0);
  return (
    rank(a) - rank(b) ||
    (a.next && b.next ? byStart(a.next, b.next) : 0) ||
    a.name.localeCompare(b.name)
  );
};

const pills: Record<CertState, { tone: string; label: string; Icon: typeof Check }> = {
  current: { tone: 'ok', label: 'Current', Icon: ShieldCheck },
  expiring: { tone: 'warn', label: 'Expires soon', Icon: Clock3 },
  expired: { tone: 'warn', label: 'Expired', Icon: AlertTriangle },
  revoked: { tone: 'danger', label: 'Revoked', Icon: Ban },
  inactive: { tone: 'neutral', label: 'Not current', Icon: AlertTriangle },
  registered: { tone: 'mine', label: 'Registered', Icon: Check },
  awaiting: { tone: 'neutral', label: 'Awaiting approval', Icon: Hourglass },
  missing: { tone: 'neutral', label: 'Not yet', Icon: GraduationCap },
};

function CertPill({ state }: { state: CertState }) {
  const { tone, label, Icon } = pills[state];
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}

function recordFacts(item: CertItem) {
  const record = item.record;
  if (!record) return [];
  const facts: string[] = [];
  if (record.instructorName) facts.push(`Approved by ${record.instructorName}`);
  if (record.trainedAt) facts.push(`Trained ${day(record.trainedAt)}`);
  if (item.state === 'revoked') facts.push('Retraining needed');
  else if (record.renewalDate)
    facts.push(`${new Date(record.renewalDate).getTime() < Date.now() ? 'Expired' : 'Renews'} ${day(record.renewalDate)}`);
  else if (record.valid) facts.push('No renewal needed');
  return facts;
}

function NextClass({ item }: { item: CertItem }) {
  const { next, state, trained } = item;
  if (state === 'awaiting' && trained)
    return (
      <div className="cert-next cert-next--quiet">
        <Hourglass aria-hidden="true" className="cert-next__icon" />
        <p>
          <strong>{trained.myStatus === 'attended' ? 'Training complete' : 'Class finished'}</strong>
          <span>
            {trained.myStatus === 'attended'
              ? 'An instructor approves your certification in person. It shows here once approved.'
              : 'Your instructor still needs to record attendance for ' + shortDate(trained.startsAt) + '.'}
          </span>
        </p>
      </div>
    );
  if (!next)
    return (
      <div className="cert-next cert-next--empty">
        <p>
          <strong>No class scheduled yet</strong>
          <span>New training sessions are posted on Classes.</span>
        </p>
        <Link className="text-link" to="/classes">
          Browse classes
        </Link>
      </div>
    );
  const registered = next.myStatus === 'enrolled';
  const full = seatsLeft(next) === 0;
  const refresher = state === 'current' || state === 'expiring';
  return (
    <div className={`cert-next${registered ? ' cert-next--mine' : ''}`}>
      <div className="cert-next__body">
        <span className="cert-next__label">
          {registered ? "You're registered" : refresher ? 'Refresher class' : 'Next class'}
        </span>
        <strong>{next.title}</strong>
        <p className="class-meta">
          <span>
            <CalendarDays aria-hidden="true" />
            {shortDate(next.startsAt)}
          </span>
          <span>
            <Clock3 aria-hidden="true" />
            {timeRange(next)}
          </span>
          <span>
            <MapPin aria-hidden="true" />
            {next.roomName}
          </span>
        </p>
        {registered ? (
          <small>After class, an instructor approves your certification in person.</small>
        ) : (
          <small className={full ? undefined : 'cert-next__seats'}>{seatText(next)}</small>
        )}
      </div>
      <Link
        className={`button button--small ${registered || full ? 'button--quiet' : 'button--primary'}`}
        to="/classes"
        aria-label={`${registered ? 'View' : full ? 'See other classes for' : 'Register for'} ${next.title} on Classes`}
      >
        {registered ? 'View on Classes' : full ? 'See other classes' : 'Register on Classes'}
        <ArrowRight aria-hidden="true" />
      </Link>
    </div>
  );
}

function CertRow({ item }: { item: CertItem }) {
  const facts = recordFacts(item);
  const needsClass = item.state !== 'current';
  return (
    <li className={`cert-row cert-row--${item.state}`}>
      <ClassThumb certification={item.name} />
      <div className="cert-row__body">
        <div className="cert-row__head">
          <h3>{item.name}</h3>
          <CertPill state={item.state} />
        </div>
        <p className="cert-row__unlocks">
          <Wrench aria-hidden="true" />
          {item.equipment.length ? (
            <span>
              <b>Unlocks</b> {item.equipment.map((e) => e.name).join(' · ')}
            </span>
          ) : (
            <span>Not linked to equipment yet</span>
          )}
        </p>
        {facts.length || (!needsClass && item.equipment.length) ? (
          <div className="cert-row__foot">
            {facts.length ? <p className="cert-row__facts">{facts.join(' · ')}</p> : <span />}
            {!needsClass && item.equipment.length ? (
              <Link className="button button--quiet button--small" to="/equipment">
                Book equipment
              </Link>
            ) : null}
          </div>
        ) : null}
        {needsClass ? <NextClass item={item} /> : null}
      </div>
    </li>
  );
}

function waiverPill(item: Waiver) {
  const terms = item.name === 'Terms of Service';
  if (item.signed)
    return (
      <span className="status-pill status-pill--ok">
        <CheckCircle2 aria-hidden="true" />
        {terms ? 'Completed' : 'Signed'}
      </span>
    );
  return (
    <span className="status-pill status-pill--warn">
      <AlertTriangle aria-hidden="true" />
      {item.expiredSignature ? 'Signature expired' : item.outdatedSignature ? 'New version' : 'Needs signature'}
    </span>
  );
}

function ErrorLine({ error, reload }: { error: string; reload: () => void }) {
  return (
    <p role="alert" className="form-error certs-error">
      {error}
      <button type="button" className="button button--quiet button--small" onClick={reload}>
        Retry
      </button>
    </p>
  );
}

export function CertificationsPage() {
  const { user } = useAuth();
  const staff = !!user?.roles.some((r) => ['admin', 'staff', 'instructor'].includes(r));
  const waivers = useApi<Waiver[]>('/me/waivers');
  const certifications = useApi<Certification[]>('/me/certifications');
  const equipment = useApi<LiveEquipment[]>('/equipment');
  const classes = useApi<ClassRecord[]>('/classes');
  const [selected, setSelected] = useState<Waiver | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const open = (item: Waiver) => {
    setSelected(item);
    setAccepted(false);
    setError('');
  };
  const sign = async (formValues?: Record<string, string>, guardianConsent = false) => {
    if (!selected || !accepted) return;
    setBusy(true);
    setError('');
    try {
      await api('/me/waivers/' + selected.id + '/sign', {
        method: 'POST',
        body: { accepted: true, ...(formValues ? { formValues, guardianConsent } : {}) },
      });
      waivers.reload();
      const completedTerms = selected.name === 'Terms of Service';
      setSelected(null);
      setToast(completedTerms ? 'Terms of Service completed.' : 'Your agreement has been recorded.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const agreementControls = selected && !selected.signed ? (
    <>
      <label className="check-control">
        <input type="checkbox" checked={accepted} disabled={busy}
          onChange={event => setAccepted(event.target.checked)} />
        <span aria-hidden="true" />
        {selected.name === 'Terms of Service'
          ? 'I have read and accept the Terms of Service.'
          : 'I have read and agree to this version of the policy.'}
      </label>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      <button className="button button--primary"
        type={selected.formFields?.length ? 'submit' : 'button'}
        disabled={!accepted || busy || !selected.description}
        onClick={selected.formFields?.length ? undefined : () => void sign()}>
        {busy ? 'Saving…' : selected.name === 'Terms of Service' ? 'Submit acceptance' : 'Record agreement'}
      </button>
    </>
  ) : null;

  // Class times are a helpful extra: certifications still show if they fail to load.
  const certsReady =
    !certifications.loading && !certifications.error && !equipment.loading && !equipment.error && !classes.loading;
  const items = certsReady
    ? certificationItems(certifications.data ?? [], equipment.data ?? [], classes.data ?? [])
    : [];
  const held = items.filter((item) => item.record).sort(byHeld);
  const toEarn = items.filter((item) => !item.record).sort(byNextStep);
  const openEquipment = (equipment.data ?? []).filter((item) => !item.certification);
  const current = held.filter((item) => item.state === 'current' || item.state === 'expiring').length;

  const waiverList = [...(waivers.data ?? [])].sort((a, b) => Number(a.signed) - Number(b.signed));
  const toSign = waiverList.filter((item) => !item.signed).length;

  return (
    <div className="certs-page page-enter">
      <header className="classes-head">
        <div>
          <p className="eyebrow">Shop access</p>
          <h1 className="display-heading">Certifications &amp; waivers</h1>
          <p className="classes-head__lead">
            Sign the shop's policies once, then take a training class to unlock each machine that needs a
            certification.
          </p>
        </div>
        {staff ? (
          <Link className="button button--quiet" to="/training">
            <GraduationCap aria-hidden="true" />
            Manage training records
          </Link>
        ) : null}
      </header>

      <div className={`certs-layout${toSign ? ' certs-layout--sign-first' : ''}`}>
        <div className="certs-main">
          <section className="certs-section" aria-labelledby="your-certifications">
            <div className="class-month__heading">
              <h2 id="your-certifications">Your certifications</h2>
              {certsReady && held.length ? <span>{current} of {held.length} current</span> : null}
            </div>
            {certifications.loading || equipment.loading || classes.loading ? (
              <p role="status">Loading certifications…</p>
            ) : null}
            {certifications.error ? <ErrorLine error={certifications.error} reload={certifications.reload} /> : null}
            {equipment.error ? <ErrorLine error={equipment.error} reload={equipment.reload} /> : null}
            {classes.error ? <ErrorLine error={classes.error} reload={classes.reload} /> : null}
            {certsReady && !items.length ? (
              <div className="classes-empty">
                <span className="classes-empty__icon" aria-hidden="true">
                  <ShieldCheck />
                </span>
                <h3>No certifications needed yet</h3>
                <p>When the shop links training to a machine, it shows up here with the class that unlocks it.</p>
                <Link className="button button--quiet" to="/equipment">
                  Book equipment
                </Link>
              </div>
            ) : certsReady && !held.length ? (
              <div className="classes-empty classes-empty--small">
                <h3>No certifications yet</h3>
                <p>Pick a training class below. Once an instructor approves you, it shows up here.</p>
              </div>
            ) : held.length ? (
              <ul className="cert-rows">
                {held.map((item) => (
                  <CertRow key={item.key} item={item} />
                ))}
              </ul>
            ) : null}
          </section>

          {toEarn.length ? (
            <section className="certs-section" aria-labelledby="earn-certifications">
              <div className="class-month__heading">
                <h2 id="earn-certifications">Earn a certification</h2>
                <span>
                  {toEarn.length} {toEarn.length === 1 ? 'certification' : 'certifications'}
                </span>
              </div>
              <ul className="cert-rows">
                {toEarn.map((item) => (
                  <CertRow key={item.key} item={item} />
                ))}
              </ul>
            </section>
          ) : null}

          {certsReady && openEquipment.length ? (
            <p className="cert-open">
              <Check aria-hidden="true" />
              <span>
                <b>No certification needed:</b> {openEquipment.map((item) => item.name).join(' · ')}
              </span>
              <Link className="text-link" to="/equipment">
                Book
              </Link>
            </p>
          ) : null}
        </div>

        <aside className="certs-aside">
          <section className="panel certs-waivers" aria-labelledby="waivers-heading">
            <div className="certs-waivers__head">
              <h2 id="waivers-heading">
                <FileText aria-hidden="true" />
                Waivers &amp; policies
              </h2>
              {waivers.data?.length ? (
                toSign ? (
                  <span className="status-pill status-pill--warn">{toSign} to sign</span>
                ) : (
                  <span className="status-pill status-pill--ok">All signed</span>
                )
              ) : null}
            </div>
            <p className="certs-waivers__lead">
              Required before you book equipment. Each waiver expires 1 year (365 days) after you sign it. Signing again starts a new 365-day period. A policy update may require you to sign again sooner.
            </p>
            {waivers.loading ? <p role="status">Loading policies…</p> : null}
            {waivers.error ? <ErrorLine error={waivers.error} reload={waivers.reload} /> : null}
            {!waivers.loading && !waivers.error && !waivers.data?.length ? (
              <p className="certs-waivers__empty">
                <FileCheck2 aria-hidden="true" />
                Nothing to sign right now.
              </p>
            ) : null}
            {waiverList.length ? (
              <ul className="waiver-rows">
                {waiverList.map((item) => (
                  <li className={`waiver-row${item.signed ? '' : ' waiver-row--todo'}`} key={item.id}>
                    <div className="waiver-row__info">
                      <h3>{item.name}</h3>
                      <div className="waiver-row__status">
                        {waiverPill(item)}
                        <span>
                          {item.signed
                            ? item.signedAt
                              ? day(item.signedAt)
                              : 'Date unavailable'
                            : `Version ${item.version}`}
                        </span>
                      </div>
                      {!item.signed && <p>{item.scope === 'equipment' ? 'Required before booking or using equipment that requires a waiver' : 'Required for facility access and day passes'}</p>}
                      {item.signed ? null : item.expiredSignature ? (
                        <p>Your signature has expired. Review and sign again. Last signed: {item.signedVersion}.</p>
                      ) : item.outdatedSignature ? (
                        <p>New version needs your signature. Last signed: {item.signedVersion ?? 'earlier version'}.</p>
                      ) : null}
                    </div>
                    {item.signed ? (
                      <button type="button" className="text-link" onClick={() => open(item)}>
                        View policy
                      </button>
                    ) : (
                      <button type="button" className="button button--primary button--small" onClick={() => open(item)}>
                        {item.outdatedSignature ? 'Review new version' : 'Review and agree'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {waiverList.some((item) => item.signed && item.formFields?.length) ? (
              <Link className="certs-waivers__copies" to="/profile">
                Download signed copies from your profile
                <ArrowRight aria-hidden="true" />
              </Link>
            ) : null}
          </section>
        </aside>
      </div>

      <Modal
        open={!!selected}
        title={selected?.name ?? 'Review policy'}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        {selected?.formFields?.length && !selected.signed ? (
          <WaiverDocumentForm key={selected.id} waiver={selected} user={user} busy={busy}
            onSubmit={(values, guardianConsent) => void sign(values, guardianConsent)}>
            {agreementControls}
          </WaiverDocumentForm>
        ) : selected ? (
          <div className="stack-form">
            <p>Version {selected.version}</p>
            <p className="policy-text">
              {selected.description || 'Policy content has not been provided.'}
            </p>
            {!selected.signed ? agreementControls : (
              <p>
                {selected.name === 'Terms of Service'
                  ? 'Terms of Service completed.'
                  : 'This version is already signed.'}
              </p>
            )}
            {selected.signed && selected.formFields?.length ? <p><Link to="/profile">Download your completed form from Signed waiver copies in your profile.</Link></p> : null}
          </div>
        ) : null}
      </Modal>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
