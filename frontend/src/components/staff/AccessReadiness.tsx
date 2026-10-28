import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../lib/useApi';
import { accessReasonLabel, type AccessReadinessResult } from '../../lib/accessReadiness';
import { dateTime } from '../../lib/display';

export function AccessReadiness({ userId, revision, headingLevel = 2 }: { userId:number; revision?:number; headingLevel?:2|3 }) {
  const [readerId,setReaderId] = useState('');
  const [now,setNow] = useState(Date.now());
  const path = `/admin/users/${userId}/access-readiness${readerId ? `?readerId=${encodeURIComponent(readerId)}` : ''}`;
  const status = useApi<AccessReadinessResult>(path, {retainOnReload:true});
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) { previousRevision.current = revision; status.reload(); }
  }, [revision,status.reload]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick,500);
    window.addEventListener('focus',tick);
    return () => {window.clearInterval(timer);window.removeEventListener('focus',tick);};
  }, []);
  const d = status.data;
  // A failed or expired preview must never leave a green Ready badge behind.
  const receivedAt = useMemo(() => Date.now(), [d]);
  const ttl = d?.allowed ? Math.min(5000, Date.parse(d.expiresAt ?? '') - Date.parse(d.checkedAt)) : 15000;
  const stale = !Number.isFinite(ttl) || now >= receivedAt + ttl;
  const current = !!d && d.userId === userId && (!readerId || d.readerId === readerId) && !status.error && !stale;
  const ready = current && d.allowed;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return <section className="access-readiness" aria-label="Reader access readiness">
    <div className="activity-title"><Heading>Reader access readiness</Heading><span className={`activity-badge is-${ready?'allowed':current?'denied':'neutral'}`}>{ready?'Ready to use':current?'Blocked':'Not verified'}</span></div>
    <p>Check whether this member can use a reader now. Every NFC card tap checks access again.</p>
    {d?.readers.length ? <label className="form-field"><span>Check access at</span><select value={readerId || d.readerId} onChange={e=>setReaderId(e.target.value)}>{d.readers.map(r=><option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}</select></label> : null}
    {status.error ? <p role="alert" className="form-error">Readiness unavailable: {status.error}</p> : current ? <p className={ready?'':'form-error'}><strong>{accessReasonLabel(d.reason)}</strong></p> : <p role="status">{status.loading?'Checking current access…':'The last check is stale. Refresh to verify access.'}</p>}
    {current && !ready ? <p>First blocking requirement shown. Further requirements are checked after it is resolved.</p> : null}
    <button type="button" className="button button--quiet" onClick={status.reload} disabled={status.loading}>{status.loading?'Checking…':'Refresh access check'}</button>
    {d ? <p className="activity-byline">Checked {dateTime(d.checkedAt)}. {d.cardAssigned?'Checks any active card assigned to this member; revoked or unknown cards still fail.':'Assign an active NFC card before scanning.'}</p> : null}
    <p className="activity-byline">Refresh after changing membership, training or waivers. This preview does not grant access.</p>
  </section>;
}
