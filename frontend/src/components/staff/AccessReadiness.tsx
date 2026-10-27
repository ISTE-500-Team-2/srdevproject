import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../lib/useApi';
import { accessReasonLabel, type AccessReadinessResult } from '../../lib/accessReadiness';
import { dateTime } from '../../lib/display';

export function AccessReadiness({ userId, revision }: { userId:number; revision?:number }) {
  const [readerId,setReaderId] = useState('');
  const [now,setNow] = useState(Date.now());
  const path = `/admin/users/${userId}/access-readiness${readerId ? `?readerId=${encodeURIComponent(readerId)}` : ''}`;
  const status = useApi<AccessReadinessResult>(path, {retainOnReload:true,refreshInterval:3000});
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
  return <section className="access-readiness" aria-label="Reader access readiness">
    <div className="activity-title"><h3>Reader access readiness</h3><span className={`activity-badge is-${ready?'allowed':current?'denied':'neutral'}`}>{ready?'Ready to use':current?'Blocked':'Not verified'}</span></div>
    <p>Live backend check for this reader—not just the account’s active flag. An actual tap is always checked again.</p>
    {d?.readers.length ? <label className="form-field"><span>Check access at</span><select value={readerId || d.readerId} onChange={e=>setReaderId(e.target.value)}>{d.readers.map(r=><option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}</select></label> : null}
    {status.error ? <p role="alert" className="form-error">Readiness unavailable: {status.error}</p> : current ? <p className={ready?'':'form-error'}><strong>{accessReasonLabel(d.reason)}</strong></p> : <p role="status">{status.loading?'Checking current access…':'The last check is stale. Refresh to verify access.'}</p>}
    {current && !ready ? <p>First blocking requirement shown. Further requirements are checked after it is resolved.</p> : null}
    <button type="button" className="button button--quiet" onClick={status.reload} disabled={status.loading}>{status.loading?'Checking…':'Refresh access check'}</button>
    {d ? <p className="activity-byline">Checked {dateTime(d.checkedAt)}. {d.cardAssigned?'Checks any active card assigned to this member; revoked or unknown cards still fail.':'Assign an active NFC card before scanning.'}</p> : null}
    <p className="activity-byline">Read-only preview: no check-in, machine activation or permission change. Refreshes automatically while you are not editing.</p>
  </section>;
}
