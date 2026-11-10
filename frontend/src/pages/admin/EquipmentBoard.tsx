import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Search, Wrench } from 'lucide-react';
import { useApi } from '../../lib/useApi';
import { LoadState } from '../../components/Management';
import { usePageWidth } from '../../components/admin/pageWidth';
import { shortDate } from '../../lib/display';
import type { Reservation } from '../../lib/contracts';
import { bookingBlock, dayKey, formatTime, machineStatus, timeWindow } from '../../lib/today';
import { equipmentRate, equipmentTime, maintenanceReasons, type EquipmentDetail, type ManagedEquipment } from '../../lib/equipmentMaintenance';
import { useDayBookings } from './useDayBookings';

const refresh = { retainOnReload: true, refreshInterval: 15000 };
const bookingRefresh = { retainOnReload: true, refreshInterval: 60000 };
/** Below this width the list keeps the whole page and a row opens the machine's own page. */
const SPLIT_WIDTH = 1360;

type Filter = 'all' | 'use' | 'booked' | 'down';
type Window = ReturnType<typeof timeWindow>;
type Tone = 'free' | 'use' | 'booked' | 'down';
interface Row { machine: ManagedEquipment; bookings: Reservation[]; live: boolean; down: boolean; bookedLater: boolean; tone: Tone; label: string; detail: string }

/** The equipment list: every machine with what it is doing now and its bookings today. */
export function EquipmentBoard() {
  usePageWidth('wide');
  const machines = useApi<ManagedEquipment[]>('/admin/equipment', refresh);
  const config = useApi<{ timeZone: string }>('/config', { ...refresh, reuse: true });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const zone = config.data?.timeZone;
  const day = zone ? dayKey(now, zone) : '';
  // Remounts at midnight so the schedule never mixes two days.
  return <BoardContent key={day} day={day} zone={zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} now={now} machines={machines} />;
}

function BoardContent({ day, zone, now, machines }: { day: string; zone: string; now: number; machines: ReturnType<typeof useApi<ManagedEquipment[]>> }) {
  const { bookings, state: bookingState, loaders } = useDayBookings(day, bookingRefresh);
  const win = timeWindow(now, zone, bookings);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [workspace, width] = useWidth();
  const split = width >= SPLIT_WIDTH;

  const rows = (machines.data ?? []).map(machine => describe(machine, bookings.filter(b => b.equipmentId === machine.id), now, zone));
  const counts: Record<Filter, number> = { all: rows.length, use: rows.filter(r => r.live).length, booked: rows.filter(r => r.bookedLater).length, down: rows.filter(r => r.down).length };
  const query = search.toLowerCase().trim();
  const visible = rows.filter(r => (filter === 'all' || (filter === 'use' && r.live) || (filter === 'booked' && r.bookedLater) || (filter === 'down' && r.down))
    && `${r.machine.name} ${r.machine.type} ${r.machine.location}`.toLowerCase().includes(query));
  const active = split ? (visible.find(r => r.machine.id === selected) ?? visible[0]) : undefined;
  // On a wide screen a row opens beside the list; modified clicks still open the page.
  const choose = (id: number) => (event: MouseEvent) => {
    if (!split || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setSelected(id);
  };
  const filters: [Filter, string][] = [['all', 'All'], ['use', 'In use'], ['booked', 'Booked today'], ['down', 'Out of service']];

  return <div className="eq-workspace eq-workspace--board" ref={workspace}>
    {loaders}
    <header className="eq-heading"><div><p className="eq-eyebrow">Operations</p><h1 className="admin-title">Equipment</h1><p>Keep the shop ready for what’s next.</p></div></header>
    <div className="eq-toolbar">
      <label className="eq-search"><Search aria-hidden="true" /><span className="sr-only">Find equipment</span><input placeholder="Find a machine…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="eq-filters" role="group" aria-label="Show equipment">
        {filters.map(([key, label]) => <button key={key} type="button" className={`eq-filter eq-filter--${key}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
          <b>{machines.data ? counts[key] : '–'}</b>{label}</button>)}
      </div>
    </div>
    <LoadState {...machines} />
    {bookingState?.error ? <div className="eq-notice"><LoadState loading={false} error={`Today’s bookings could not be loaded. ${bookingState.error}`} reload={bookingState.reload} /></div> : null}
    {machines.data && <div className={`eq-split${active ? ' eq-split--open' : ''}`}>
      <div className="eq-board">
        <div className="eq-row eq-row--head" aria-hidden="true"><span>Machine</span><span>Status</span><span className="eq-row__day"><span>Today</span><Ticks win={win} /></span><span className="eq-row__cert">Requires</span><span className="eq-row__rate">Rate</span><span /></div>
        {visible.map(row => <Link key={row.machine.id} to={`/admin/equipment/${row.machine.id}`} className="eq-row" onClick={choose(row.machine.id)} aria-current={active?.machine.id === row.machine.id ? 'true' : undefined}>
          <span className="eq-row__name"><img src={row.machine.image} alt="" /><span><strong>{row.machine.name}</strong><small>{row.machine.type} · {row.machine.location}</small></span></span>
          <span className="eq-row__status"><span className={`eq-pill eq-pill--${row.tone}`}>{row.label}</span><small>{row.detail}</small></span>
          <span className="eq-row__day"><DayStrip row={row} win={win} now={now} zone={zone} /></span>
          <span className="eq-row__cert">{row.machine.certification ?? <em>None</em>}</span>
          <span className="eq-row__rate">{row.machine.rate === null ? '—' : `$${row.machine.rate.toFixed(0)}/hr`}</span>
          <ChevronRight aria-hidden="true" className="eq-row__chev" />
        </Link>)}
        {!visible.length && <p className="eq-empty">No equipment matches this view.</p>}
      </div>
      {active && <MachinePanel key={active.machine.id} row={active} win={win} now={now} zone={zone} />}
    </div>}
  </div>;
}

/** What a machine is doing now, in a few words, and what comes next. */
function describe(machine: ManagedEquipment, bookings: Reservation[], now: number, zone: string): Row {
  const live = !!machine.activeReaderLeases, down = machine.status !== 'available';
  const bookedLater = bookings.some(b => Date.parse(b.endTime) > now);
  const base = { machine, bookings, live, down, bookedLater };
  if (down) {
    const outage = machine.outage;
    return { ...base, tone: 'down', label: 'Out of service', detail: `${outage ? maintenanceReasons[outage.reason] ?? 'Unavailable' : 'Unavailable'}${outage?.expectedBack ? ` · back ${shortDate(outage.expectedBack)}` : ''}` };
  }
  const current = bookings.find(b => Date.parse(b.startTime) <= now && Date.parse(b.endTime) > now);
  const { nextText } = machineStatus(bookings, now, zone, live, down);
  if (live) return { ...base, tone: 'use', label: 'In use', detail: current ? nextText : 'Reader session active' };
  if (current) return { ...base, tone: 'booked', label: `Booked until ${formatTime(current.endTime, zone)}`, detail: current.memberName ?? '' };
  return { ...base, tone: 'free', label: 'Available', detail: nextText };
}

function DayStrip({ row, win, now, zone, large }: { row: Row; win: Window; now: number; zone: string; large?: boolean }) {
  const blocks = row.bookings.map(b => bookingBlock(b, win, now, zone, row.live, row.down)).filter(b => b !== null);
  return <div className={`eq-day${large ? ' eq-day--large' : ''}`} role="img" aria-label={blocks.length ? `Today: ${blocks.map(b => b.label).join('; ')}` : 'Nothing booked today'}>
    {row.down && <span className="eq-day__outage" />}
    {blocks.map(b => <span key={b.id} className={`eq-day__block eq-day__block--${b.kind}`} style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%` }}>{large ? b.text : null}</span>)}
    {win.nowInsideWindow && <i className="eq-day__now" style={{ left: `${win.nowFraction * 100}%` }} />}
  </div>;
}

function Ticks({ win }: { win: Window }) {
  return <span className="eq-ticks" aria-hidden="true">{win.ticks.map(t => <span key={t.fraction} style={{ left: `${t.fraction * 100}%` }}>{t.label}</span>)}</span>;
}

function MachinePanel({ row, win, now, zone }: { row: Row; win: Window; now: number; zone: string }) {
  const detail = useApi<EquipmentDetail>(`/admin/equipment/${row.machine.id}`, refresh);
  const { machine } = row;
  const last = detail.data?.history[0];
  return <aside className="eq-panel eq-machine-panel" aria-label={`${machine.name} details`}>
    <div className="eq-mp-head"><img src={machine.image} alt="" /><div><p className="eq-eyebrow">{machine.type} · {machine.location}</p><h2>{machine.name}</h2><span className={`eq-pill eq-pill--${row.tone}`}>{row.label}</span></div></div>
    <dl className="eq-facts">
      <div><dt>Rate</dt><dd>{equipmentRate(machine.rate)}</dd></div>
      <div><dt>Requires</dt><dd>{machine.certification ?? 'No training'}</dd></div>
      <div><dt>Last outage</dt><dd>{detail.data ? last ? new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium' }).format(new Date(last.startedAt)) : 'None recorded' : '…'}</dd></div>
    </dl>
    {machine.outage && <p className="eq-warning">{maintenanceReasons[machine.outage.reason] ?? 'Unavailable'} since {equipmentTime(machine.outage.startedAt, zone)}.{machine.outage.expectedBack ? ` Estimated back ${shortDate(machine.outage.expectedBack, true)}.` : ' No return date set.'}</p>}
    <h3 className="eq-mp-label">Today</h3>
    <DayStrip row={row} win={win} now={now} zone={zone} large />
    <Ticks win={win} />
    <h3 className="eq-mp-label">Bookings today</h3>
    {row.bookings.length ? <ul className="eq-mp-bookings">{row.bookings.map(b => {
      const done = Date.parse(b.endTime) <= now, started = Date.parse(b.startTime) <= now;
      return <li key={b.id} className={done ? 'is-done' : undefined}>
        <span><strong>{formatTime(b.startTime, zone)} – {formatTime(b.endTime, zone)}</strong><small>{b.memberName}</small></span>
        <span className={`eq-pill eq-pill--${done ? 'past' : started ? 'use' : 'booked'}`}>{done ? 'Done' : started ? 'Now' : 'Upcoming'}</span>
      </li>;
    })}</ul> : <p className="eq-muted">Nothing booked today.</p>}
    <div className="eq-actions eq-mp-actions">
      <Link className="button button--primary" to={`/admin/equipment/${machine.id}`}>Open machine <ArrowUpRight aria-hidden="true" /></Link>
      {detail.data?.canManage && <Link className="button button--quiet" to={`/admin/equipment/${machine.id}`} state={{ editAvailability: true }}><Wrench aria-hidden="true" />{row.down ? 'Return to service' : 'Take out of service'}</Link>}
    </div>
  </aside>;
}

/** The element's content width, kept current as the window or sidebar changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
