import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Search, Wrench } from 'lucide-react';
import { useApi } from '../../lib/useApi';
import { LoadState } from '../../components/Management';
import { shortDate, zonedDay } from '../../lib/display';
import { equipmentRate, equipmentTime, maintenanceReasons, type EquipmentDetail, type ManagedEquipment } from '../../lib/equipmentMaintenance';
import { AvailabilityForm, EquipmentBookings } from './EquipmentWorkflows';
import './equipment.css';

const refresh = { retainOnReload: true, refreshInterval: 15000 };
export function EquipmentManagementPage() {
  const { equipmentId } = useParams();
  return equipmentId ? <EquipmentDetailPage key={equipmentId} id={equipmentId} /> : <EquipmentList />;
}
function EquipmentList() {
  const result = useApi<ManagedEquipment[]>('/admin/equipment', refresh);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const machines = result.data ?? [];
  const down = machines.filter(m => m.status !== 'available').length;
  const visible = machines.filter(m => (filter !== 'down' || m.status !== 'available') && `${m.name} ${m.type} ${m.location}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <div className="eq-workspace">
    <header className="eq-heading"><div><p className="eq-eyebrow">Operations</p><h1 className="admin-title">Equipment</h1><p>Keep the shop ready for what’s next.</p></div>
      {result.data && <span className={`eq-pill${down ? ' eq-pill--down' : ''}`}>{down ? <Wrench aria-hidden="true" /> : <Check aria-hidden="true" />}{down} out of service</span>}
    </header>
    <div className="eq-toolbar"><label className="eq-search"><Search aria-hidden="true" /><span className="sr-only">Find equipment</span><input placeholder="Find a machine…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label><span className="sr-only">Equipment status</span><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All equipment</option><option value="down">Out of service</option></select></label>
      <button className="button button--quiet" onClick={result.reload}>Refresh</button>
    </div>
    <LoadState {...result} />
    <div className="eq-list">{visible.map(m => <Link className="eq-machine-row" key={m.id} to={`/admin/equipment/${m.id}`}>
      <img src={m.image} alt="" /><div className="eq-machine-name"><strong>{m.name}</strong><span>{m.type} · {m.location}</span></div>
      <div className="eq-machine-state"><span className={`eq-pill${m.status !== 'available' ? ' eq-pill--down' : ''}`}>{m.status === 'available' ? m.activeReaderLeases ? 'In use' : 'Available' : 'Out of service'}</span>
        {m.outage && <small>{maintenanceReasons[m.outage.reason]}{m.outage.expectedBack ? ` · Est. ${shortDate(m.outage.expectedBack)}` : ''}</small>}</div><ChevronRight aria-hidden="true" />
    </Link>)}</div>
    {result.data && !visible.length && <p className="eq-empty">No equipment matches this view.</p>}
  </div>;
}
function EquipmentDetailPage({ id }: { id: string }) {
  const result = useApi<EquipmentDetail>(`/admin/equipment/${id}`, refresh);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [bookingRevision, setBookingRevision] = useState(0);
  const machine = result.data;
  const changed = () => { result.reload(); setBookingRevision(v => v + 1); };
  return <div className="eq-workspace">
    <Link className="eq-back" to="/admin/equipment"><ArrowLeft aria-hidden="true" />All equipment</Link>
    <LoadState {...result} />
    {message && <p className="eq-success" role="status"><Check aria-hidden="true" />{message}</p>}
    {machine && <>
      <header className="eq-detail-head"><img src={machine.image} alt="" /><div><p className="eq-eyebrow">{machine.type} · {machine.location}</p><h1 className="admin-title">{machine.name}</h1><p>{equipmentRate(machine.rate)}{machine.certification ? ` · ${machine.certification} certification` : ''}</p></div></header>
      <div className="eq-detail-grid"><div className="eq-detail-main">
        <section className={`eq-panel eq-availability${machine.status !== 'available' ? ' eq-availability--down' : ''}`} aria-label="Availability">
          <div className="eq-section-head"><div><p className="eq-eyebrow">Availability</p><h2>{machine.status !== 'available' ? 'Out of service' : machine.activeGrants.length ? 'In use' : 'Ready to book'}</h2></div><Wrench aria-hidden="true" /></div>
          {machine.outage ? <><p>{maintenanceReasons[machine.outage.reason]} · Since {equipmentTime(machine.outage.startedAt, machine.timeZone)}</p>
            <p>{machine.outage.expectedBack ? `Estimated back ${shortDate(machine.outage.expectedBack, true)}. ` : 'No return date set. '}An administrator must return this machine to service.</p>
            {machine.outage.expectedBack && machine.outage.expectedBack < zonedDay(machine.timeZone) && <p className="eq-warning">The estimated return date has passed. This machine is still out of service.</p>}
            {machine.outage.staffNote && <div className="eq-private-note"><span className="eq-eyebrow">Staff note</span><p>{machine.outage.staffNote}</p></div>}
          </> : <p>{machine.status !== 'available' ? 'This machine is unavailable. Return it to service when it is ready.' : machine.activeGrants.length ? 'A reader session is active. Availability can change once it ends.' : 'Members can reserve this machine and use it during their booking.'}</p>}
          {!machine.canManage && <p className="eq-muted">An administrator can change equipment availability.</p>}
          {machine.canManage && !editing && <button className={`button ${machine.status === 'available' ? 'button--quiet' : 'button--primary'}`} onClick={() => { setEditing(true); setMessage(''); }}>{machine.status === 'available' ? 'Take out of service' : 'Return to service'}</button>}
          {editing && machine.canManage && <AvailabilityForm initial={machine} onClose={() => setEditing(false)} onSaved={text => { setEditing(false); setMessage(text); changed(); }} />}
        </section>
        {machine.canReadBookings ? <EquipmentBookings key={bookingRevision} machine={machine} onChanged={text => { setMessage(text); changed(); }} /> : <section className="eq-panel"><h2>Upcoming bookings</h2><p>Reservation read permission is required to view bookings.</p></section>}
      </div>
      <aside className="eq-panel eq-history"><div className="eq-section-head"><h2>Service history</h2><Link to="/admin/change-log" aria-label="Open change log"><ArrowUpRight aria-hidden="true" /></Link></div>
        <p className="eq-muted">The 20 most recent service periods. All changes are recorded in the change log.</p>
        {!machine.history.length && <p className="eq-empty">No maintenance recorded yet.</p>}
        <ol>{machine.history.map(o => <li key={o.id}><strong>{maintenanceReasons[o.reason]}</strong><span>Taken out of service by {o.startedBy}</span><time>{equipmentTime(o.startedAt, machine.timeZone)}</time>{o.staffNote && <p>{o.staffNote}</p>}
          {o.endedAt ? <div className="eq-history-return"><strong>Returned to service</strong><span>{o.endedBy} · {equipmentTime(o.endedAt, machine.timeZone)}</span>{o.returnNote && <p>{o.returnNote}</p>}</div> : <span className="eq-pill eq-pill--down">Ongoing</span>}</li>)}</ol>
      </aside></div>
    </>}
  </div>;
}
