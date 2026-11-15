import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Search, Wrench } from 'lucide-react';
import { useApi } from '../../lib/useApi';
import { LoadState } from '../../components/Management';
import { Skeleton, SkeletonGroup } from '../../components/Skeleton';
import { usePageWidth } from '../../components/admin/pageWidth';
import { shortDate } from '../../lib/display';
import type { Reservation } from '../../lib/contracts';
import { bookingBlock, dayKey, formatTime, localHour, machineStatus, mergeBookings, previousDay, timeWindow } from '../../lib/today';
import { equipmentRate, equipmentTime, maintenanceReasons, type EquipmentDetail, type ManagedEquipment } from '../../lib/equipmentMaintenance';
import { useDayBookings } from '../../lib/useDayBookings';
import { EquipmentEditor, type CatalogOptions } from './EquipmentEditor';

const refresh = { retainOnReload: true, refreshInterval: 15000 };
const bookingRefresh = { retainOnReload: true, refreshInterval: 60000 };
/** Below this width the list keeps the whole page and a row opens the machine's own page.
 *  960 is the workspace beside the sidebar on a 1280px laptop: a 360px panel and a list that stacks. */
const SPLIT_WIDTH = 960;

type Filter = 'all' | 'use' | 'booked' | 'down';
type Window = ReturnType<typeof timeWindow>;
type Tone = 'free' | 'use' | 'booked' | 'down';
/** Whether today's bookings are all loaded; until they are, nothing is said about them. */
type Schedule = 'known' | 'loading' | 'unavailable';
/** `pending`: the status depends on bookings that are still loading, so it shows as a placeholder. */
interface Row { machine: ManagedEquipment; bookings: Reservation[]; schedule: Schedule; live: boolean; down: boolean; bookedToday: boolean; pending: boolean; tone: Tone; label: string; detail: string }

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
  const catalog = useApi<CatalogOptions>('/admin/equipment/catalog-options');
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  // The bookings list matches by start date, so a booking running past midnight is
  // in yesterday's list: read both and keep what reaches into today.
  const today = useDayBookings(day, bookingRefresh);
  const yesterday = useDayBookings(day && previousDay(day), bookingRefresh);
  const failed = today.failed ?? yesterday.failed;
  const schedule: Schedule = !day ? 'loading' : failed ? 'unavailable' : today.state ?? yesterday.state ? 'loading' : 'known';
  const bookings = schedule === 'known' ? mergeBookings(today.bookings, yesterday.bookings.filter(b => Date.parse(b.endTime) > localHour(day, 0, zone))) : [];
  const win = timeWindow(now, zone, bookings);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [workspace, width] = useWidth();
  const split = width >= SPLIT_WIDTH;

  const rows = (machines.data ?? []).map(machine => describe(machine, bookings.filter(b => b.equipmentId === machine.id), schedule, now, zone));
  const counts: Record<Filter, number> = { all: rows.length, use: rows.filter(r => r.live).length, booked: rows.filter(r => r.bookedToday).length, down: rows.filter(r => r.down).length };
  const query = search.toLowerCase().trim();
  const visible = rows.filter(r => (filter === 'all' || (filter === 'use' && r.live) || (filter === 'booked' && r.bookedToday) || (filter === 'down' && r.down))
    && `${r.machine.name} ${r.machine.type} ${r.machine.location}`.toLowerCase().includes(query));
  const active = split ? (visible.find(r => r.machine.id === selected) ?? visible[0]) : undefined;
  // On a wide screen a row opens beside the list; modified clicks still open the page.
  const choose = (id: number) => (event: MouseEvent) => {
    if (!split || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setSelected(id);
  };
  const board = useJoin(active && `${active.machine.id}:${visible.map(r => r.machine.id).join(',')}`);
  const filters: [Filter, string][] = [['all', 'All'], ['use', 'In use'], ['booked', 'Booked today'], ['down', 'Out of service']];

  return <div className="eq-workspace eq-workspace--board" ref={workspace}>
    {today.loaders}
    {yesterday.loaders}
    <header className="eq-heading"><div><p className="eq-eyebrow">Operations</p><h1 className="admin-title">Equipment</h1><p>Keep the shop ready for what’s next.</p></div>{catalog.data?.canManage && <button className="button button--primary" onClick={() => setAdding(true)}>Add equipment</button>}</header>
    {adding && <EquipmentEditor onClose={() => setAdding(false)} onSaved={id => { setAdding(false); machines.reload(); navigate(`/admin/equipment/${id}`); }} />}
    <div className="eq-toolbar">
      <label className="eq-search"><Search aria-hidden="true" /><span className="sr-only">Find equipment</span><input placeholder="Find a machine…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="eq-filters" role="group" aria-label="Show equipment">
        {filters.map(([key, label]) => <button key={key} type="button" className={`eq-filter eq-filter--${key}`} aria-pressed={filter === key} onClick={() => setFilter(key)}
          disabled={key === 'booked' && schedule !== 'known'}><b className={machines.data && counts[key] === 0 ? 'is-zero' : undefined}>{machines.data && (key !== 'booked' || schedule === 'known') ? counts[key] : '–'}</b>{label}</button>)}
      </div>
    </div>
    <LoadState loading={false} error={machines.error} reload={machines.reload} />
    {failed ? <div className="eq-notice"><LoadState loading={false} error={`Today’s bookings could not be loaded. ${failed.error}`} reload={failed.reload} /></div> : null}
    {machines.loading && <SkeletonGroup label="Loading equipment" className="eq-board"><BoardHead win={win} />{boardPlaceholders.map((widths, index) => <RowLoading key={index} widths={widths} />)}</SkeletonGroup>}
    {machines.data && <div className={`eq-split${active ? ' eq-split--open' : ''}`}>
      <div className="eq-board" ref={board}>
        <BoardHead win={win} />
        {visible.map(row => <Link key={row.machine.id} to={`/admin/equipment/${row.machine.id}`} className="eq-row" onClick={choose(row.machine.id)} aria-current={active?.machine.id === row.machine.id ? 'true' : undefined}>
          <span className="eq-row__name"><img src={row.machine.image} alt="" /><span><strong>{row.machine.name}</strong><small>{row.machine.type} · {row.machine.location}</small></span></span>
          <span className="eq-row__status">{row.pending
            ? <><Skeleton round width={104} height={27} /><Skeleton className="eq-row__detail" width={120} height={12} /></>
            : <><span className={`eq-pill eq-pill--${row.tone}`}>{row.label}</span><small>{row.detail}</small></>}</span>
          <span className="eq-row__day"><DayStrip row={row} win={win} now={now} zone={zone} /></span>
          <span className="eq-row__cert">{row.machine.certification ?? <em>None</em>}</span>
          <span className="eq-row__rate">{row.machine.rate === null ? '—' : shortRate(row.machine.rate)}</span>
          <ChevronRight aria-hidden="true" className="eq-row__chev" />
        </Link>)}
        {!visible.length && <p className="eq-empty">No equipment matches this view.</p>}
      </div>
      {active && <MachinePanel key={active.machine.id} row={active} win={win} now={now} zone={zone} />}
    </div>}
  </div>;
}

function BoardHead({ win }: { win: Window }) {
  return <div className="eq-row eq-row--head" aria-hidden="true"><span>Machine</span><span>Status</span><span className="eq-row__day"><span>Today</span><Ticks win={win} /></span><span className="eq-row__cert">Requires</span><span className="eq-row__rate">Rate</span><span /></div>;
}

/** Widths of the name, type, training and rate placeholders in each loading row. */
const boardPlaceholders: [string, string, string, string][] = [
  ['52%', '64%', '58%', '70%'], ['38%', '72%', '46%', '54%'], ['60%', '58%', '52%', '40%'],
  ['44%', '66%', '62%', '64%'], ['56%', '50%', '48%', '52%'], ['40%', '70%', '56%', '46%'],
];

/** One board row in outline, shown until the machines arrive. */
function RowLoading({ widths: [name, type, cert, rate] }: { widths: [string, string, string, string] }) {
  return <div className="eq-row eq-row--loading">
    <span className="eq-row__name"><Skeleton className="eq-row__photo" width={48} height={48} /><span className="skeleton-lines"><Skeleton width={name} height={17} /><Skeleton width={type} height={12} /></span></span>
    <span className="eq-row__status"><Skeleton round width={100} height={27} /><Skeleton className="eq-row__detail" width={120} height={12} /></span>
    <span className="eq-row__day"><span className="eq-day eq-day--loading"><Skeleton width="100%" height="100%" /></span></span>
    <span className="eq-row__cert"><Skeleton width={cert} height={12} /></span>
    <span className="eq-row__rate"><Skeleton width={rate} height={12} /></span>
    <ChevronRight aria-hidden="true" className="eq-row__chev" />
  </div>;
}

/** What a machine is doing now, in a few words, and what comes next. */
function describe(machine: ManagedEquipment, bookings: Reservation[], schedule: Schedule, now: number, zone: string): Row {
  const live = !!machine.activeReaderLeases, down = machine.status !== 'available';
  const base = { machine, bookings, schedule, live, down, bookedToday: bookings.length > 0, pending: false };
  if (down) {
    const outage = machine.outage;
    return { ...base, tone: 'down', label: 'Out of service', detail: `${outage ? maintenanceReasons[outage.reason] ?? 'Unavailable' : 'Unavailable'}${outage?.expectedBack ? ` · back ${shortDate(outage.expectedBack)}` : ''}` };
  }
  const current = bookings.find(b => Date.parse(b.startTime) <= now && Date.parse(b.endTime) > now);
  const { nextText } = machineStatus(bookings, now, zone, live, down);
  if (live) return { ...base, tone: 'use', label: 'In use', detail: current ? nextText : 'Reader session active' };
  if (schedule === 'loading') return { ...base, pending: true, tone: 'free', label: '', detail: '' };
  if (schedule === 'unavailable') return { ...base, tone: 'free', label: 'Not in use', detail: 'Bookings unavailable' };
  if (current) return { ...base, tone: 'booked', label: `Booked until ${formatTime(current.endTime, zone)}`, detail: current.memberName ?? '' };
  return { ...base, tone: 'free', label: 'Available', detail: nextText };
}

function DayStrip({ row, win, now, zone, large }: { row: Row; win: Window; now: number; zone: string; large?: boolean }) {
  const blocks = row.bookings.map(b => bookingBlock(b, win, now, zone, row.live, row.down)).filter(b => b !== null);
  const label = row.schedule === 'loading' ? 'Loading today’s bookings' : row.schedule === 'unavailable' ? 'Today’s bookings are unavailable'
    : blocks.length ? `Today: ${blocks.map(b => b.label).join('; ')}` : 'Nothing booked today';
  if (row.schedule === 'loading' && !row.down)
    return <div className={`eq-day eq-day--loading${large ? ' eq-day--large' : ''}`} role="img" aria-label={label}><Skeleton width="100%" height="100%" /></div>;
  return <div className={`eq-day${large ? ' eq-day--large' : ''}${row.schedule !== 'known' ? ' eq-day--unknown' : ''}`} role="img" aria-label={label}>
    {row.down && <span className="eq-day__outage" />}
    {blocks.map(b => <span key={b.id} className={`eq-day__block eq-day__block--${b.kind}`} style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%` }}>{large ? b.text : null}</span>)}
    {win.nowInsideWindow && <i className="eq-day__now" style={{ left: `${win.nowFraction * 100}%` }} />}
  </div>;
}

/** A rate per hour, with cents only when it has any: $12/hr, $15.50/hr. */
function shortRate(rate: number) {
  return `$${rate.toFixed(Number.isInteger(rate) ? 0 : 2)}/hr`;
}

function Ticks({ win }: { win: Window }) {
  return <span className="eq-ticks" aria-hidden="true">{win.ticks.map(t => <span key={t.fraction} style={{ left: `${t.fraction * 100}%` }}>{t.label}</span>)}</span>;
}

function MachinePanel({ row, win, now, zone }: { row: Row; win: Window; now: number; zone: string }) {
  const detail = useApi<EquipmentDetail>(`/admin/equipment/${row.machine.id}`, refresh);
  const { machine } = row;
  const last = detail.data?.history[0];
  return <aside className="eq-panel eq-machine-panel" aria-label={`${machine.name} details`}><div className="eq-mp-body">
    <div className="eq-mp-head"><img src={machine.image} alt="" /><div><p className="eq-eyebrow">{machine.type} · {machine.location}</p><h2>{machine.name}</h2>{row.pending ? <Skeleton round width={96} height={27} /> : <span className={`eq-pill eq-pill--${row.tone}`}>{row.label}</span>}</div></div>
    <dl className="eq-facts">
      <div><dt>Rate</dt><dd>{machine.rate === null ? equipmentRate(null) : shortRate(machine.rate)}</dd></div>
      <div><dt>Requires</dt><dd>{machine.certification ?? 'None'}</dd></div>
      <div><dt>Last outage</dt><dd>{detail.data ? last ? new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium' }).format(new Date(last.startedAt)) : 'None recorded'
        : detail.error ? 'Unavailable' : <><Skeleton width="76%" height={14} /><span className="sr-only">Loading</span></>}</dd></div>
    </dl>
    {detail.error ? <div className="eq-notice"><LoadState loading={false} error={`Machine details could not be loaded. ${detail.error}`} reload={detail.reload} /></div> : null}
    {machine.outage && <p className="eq-warning">{maintenanceReasons[machine.outage.reason] ?? 'Unavailable'} since {equipmentTime(machine.outage.startedAt, zone)}.{machine.outage.expectedBack ? ` Estimated back ${shortDate(machine.outage.expectedBack, true)}.` : ' No return date set.'}</p>}
    <h3 className="eq-mp-label">Today</h3>
    <DayStrip row={row} win={win} now={now} zone={zone} large />
    <Ticks win={win} />
    <h3 className="eq-mp-label">Bookings today</h3>
    {row.schedule === 'loading' ? <SkeletonGroup label="Loading today’s bookings"><ul className="eq-mp-bookings">{[130, 118].map(width => <li key={width}>
        <span className="skeleton-lines"><Skeleton width={width} height={16} /><Skeleton width={width - 30} height={12} /></span><Skeleton round width={76} height={27} />
      </li>)}</ul></SkeletonGroup>
      : row.schedule === 'unavailable' ? <p className="eq-muted">Today’s bookings could not be loaded.</p>
      : row.bookings.length ? <ul className="eq-mp-bookings">{row.bookings.map(b => {
      const done = Date.parse(b.endTime) <= now, started = Date.parse(b.startTime) <= now;
      return <li key={b.id} className={done ? 'is-done' : undefined}>
        <span><strong>{formatTime(b.startTime, zone)} – {formatTime(b.endTime, zone)}</strong><small>{b.memberName}</small></span>
        {/* An outage overrides the booking, as the strip's conflict block shows. */}
        <span className={`eq-pill eq-pill--${done ? 'past' : row.down ? 'down' : started ? 'use' : 'booked'}`}>{done ? 'Done' : row.down ? 'Affected by outage' : started ? 'Now' : 'Upcoming'}</span>
      </li>;
    })}</ul> : <p className="eq-muted">Nothing booked today.</p>}
    <div className="eq-actions eq-mp-actions">
      <Link className="button button--primary" to={`/admin/equipment/${machine.id}`}>Open machine <ArrowUpRight aria-hidden="true" /></Link>
      {detail.data?.canManage && <Link className="button button--quiet" to={`/admin/equipment/${machine.id}`} state={{ editDetails: true }}>Edit equipment</Link>}
      {detail.data?.canManage && <Link className="button button--quiet" to={`/admin/equipment/${machine.id}`} state={{ editAvailability: true }}><Wrench aria-hidden="true" />{row.down ? 'Return to service' : 'Take out of service'}</Link>}
    </div>
  </div></aside>;
}

/** The day before a YYYY-MM-DD day. */
/** The element's content width, kept current as the window or sidebar changes. */
/** Marks where the selected row meets the panel, so the panel's edge opens there and the two share one outline. */
function useJoin(key: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const board = ref.current, split = board?.parentElement;
    if (!board || !split || key === undefined) return;
    const measure = () => {
      const row = board.querySelector<HTMLElement>('a.eq-row[aria-current="true"]');
      if (!row) return;
      // The row's outline runs 1px above it and ends with its bottom edge; the gap is what lies between.
      split.style.setProperty('--eq-join-top', `${board.clientTop + row.offsetTop}px`);
      split.style.setProperty('--eq-join-height', `${row.offsetHeight - 1}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [key]);
  return ref;
}

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
