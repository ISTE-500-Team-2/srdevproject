import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  Banknote,
  ChevronRight,
  Drill,
  FilePenLine,
  GraduationCap,
  Monitor,
  Nfc,
  Wrench,
} from "lucide-react";
import { LoadState } from "../../components/Management";
import type { LiveEquipment, Reservation } from "../../lib/contracts";
import type { ComplianceReport, Page } from "../../lib/staffContracts";
import type { Rental, Studio } from "../../lib/studioContracts";
import {
  bookingBlock,
  dayKey,
  equipmentBookings,
  formatTime,
  groupMachines,
  initials,
  machineStatus,
  needsYou,
  studioOccupancy,
  studioPaymentsToRecord,
  timeWindow,
  tone,
  type NeedsYouItem,
} from "../../lib/today";
import { useApi } from "../../lib/useApi";
import type { Report } from "../ReportsPage";
import "./today.css";

const refresh = { retainOnReload: true, refreshInterval: 60000 };
type Result<T> = { data: T | null; loading: boolean; error: string; reload: () => void };

/** The first result still loading or failed, so a panel can show its LoadState. */
function waitingOn(...results: Result<unknown>[]) {
  return results.find((r) => !r.data && (r.loading || r.error)) ?? results.find((r) => !r.data);
}

/** The staff landing page: what's happening in the shop today and what needs staff. */
export function TodayPage() {
  const config = useApi<{ timeZone: string }>("/config", refresh);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const day = config.data ? dayKey(now, config.data.timeZone) : "";
  // A new day remounts everything so no panel mixes yesterday's data with today's.
  return <TodayContent key={day} config={config} now={now} day={day} />;
}

// The staff bookings list is paged; each page keeps its own refresh and retry.
type BookingPageResult = Result<Page<Reservation>>;
function BookingPage({ day, offset, receive }: { day: string; offset: number; receive: (offset: number, result: BookingPageResult) => void }) {
  const { data, loading, error, reload } = useApi<Page<Reservation>>(
    `/admin/reservations?date=${day}${offset ? `&offset=${offset}` : ""}`,
    refresh,
  );
  useEffect(() => {
    receive(offset, { data, loading, error, reload });
  }, [offset, receive, data, loading, error, reload]);
  return null;
}

function useTodayBookings(day: string) {
  const [pages, setPages] = useState<Record<number, BookingPageResult>>({});
  const receive = useCallback(
    (offset: number, result: BookingPageResult) => setPages((previous) => ({ ...previous, [offset]: result })),
    [],
  );
  const offsets = [0];
  for (let next = pages[0]?.data?.nextOffset; next != null && !offsets.includes(next); next = pages[next]?.data?.nextOffset)
    offsets.push(next);
  const missing = offsets.map((offset) => pages[offset]).find((page) => !page?.data);
  const state: Result<unknown> | undefined = offsets.every((offset) => pages[offset]?.data)
    ? undefined
    : (missing ?? { data: null, loading: true, error: "", reload: () => {} });
  const bookings = equipmentBookings(offsets.flatMap((offset) => pages[offset]?.data?.items ?? []));
  const loaders = day
    ? offsets.map((offset) => <BookingPage key={offset} day={day} offset={offset} receive={receive} />)
    : null;
  return { bookings, state, loaders };
}

function TodayContent({ config, now, day }: { config: Result<{ timeZone: string }>; now: number; day: string }) {
  const zone = config.data?.timeZone;
  const report = useApi<Report>(day ? `/admin/reports?period=daily&from=${day}&to=${day}` : null, refresh);
  const equipment = useApi<LiveEquipment[]>("/equipment", refresh);
  const studios = useApi<{ studios: Studio[] }>("/studios", refresh);
  const rentals = useApi<Rental[]>("/studio-management/rentals", refresh);
  const compliance = useApi<ComplianceReport>("/admin/compliance?userStatus=active&attention=true", refresh);
  const { bookings, state: bookingState, loaders } = useTodayBookings(day);

  const live = new Set(
    report.data?.live
      .filter((lease) => lease.kind === "equipment" && lease.activeReaderLeases > 0 && lease.resourceId !== null)
      .map((lease) => lease.resourceId),
  );
  const people = report.data?.checkedInTodayCount ?? 0;
  const date = zone
    ? new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(now) + "."
    : "";
  const summary = report.data
    ? ` ${people} ${people === 1 ? "person" : "people"} checked in today, ${live.size} ${live.size === 1 ? "machine" : "machines"} running.`
    : "";
  const studioList = studios.data?.studios ?? null;

  return (
    <div className="today">
      {loaders}
      <header className="today-head">
        <h1 className="today-title">Today</h1>
        <p className="today-summary">
          {date}
          {summary}
        </p>
      </header>
      <div className="today-grid">
        <div className="today-col">
          <FloorPanel
            state={waitingOn(config, equipment) ?? bookingState}
            zone={zone}
            now={now}
            machines={equipment.data ?? []}
            bookings={bookings}
            live={live}
          />
          <div className="today-pair">
            <StudiosPanel
              state={waitingOn(config, { ...studios, data: studioList })}
              studios={studioList ? studioOccupancy(studioList, day) : []}
            />
            <ClassesPanel state={waitingOn(config, report)} report={report.data} zone={zone} />
          </div>
        </div>
        <div className="today-col today-col--side">
          <NeedsPanel
            state={waitingOn(config, compliance, equipment) ?? bookingState}
            items={
              compliance.data
                ? needsYou(compliance.data, equipment.data ?? [], bookings, now, studioPaymentsToRecord(rentals.data ?? []))
                : []
            }
          />
          <CheckedInPanel state={waitingOn(config, report)} report={report.data} zone={zone} />
        </div>
      </div>
    </div>
  );
}

function FloorPanel({
  state,
  zone,
  now,
  machines,
  bookings,
  live,
}: {
  state: Result<unknown> | undefined;
  zone?: string;
  now: number;
  machines: LiveEquipment[];
  bookings: Reservation[];
  live: Set<number | null>;
}) {
  const window = zone && !state ? timeWindow(now, zone, bookings) : null;
  return (
    <section className="today-panel" aria-labelledby="today-floor-title">
      <div className="today-panel-head">
        <h2 id="today-floor-title">On the floor</h2>
        <div className="today-legend" role="list" aria-label="Timeline key">
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--live" aria-hidden="true" />
            In use at the reader
          </span>
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--booked" aria-hidden="true" />
            Booked
          </span>
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--down" aria-hidden="true" />
            Out of service
          </span>
        </div>
      </div>
      {state ? <LoadState {...state} /> : null}
      {window && zone ? (
        machines.length ? (
          <div
            className="today-floor"
            style={{ "--today-now": window.nowFraction, "--today-hours": window.windowHours } as CSSProperties}
          >
            <div className="today-axis" aria-hidden="true">
              <div />
              <div className="today-ticks">
                {window.ticks.map((tick) => (
                  <span key={tick.fraction} className="today-tick" style={{ left: `${tick.fraction * 100}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
            {window.nowInsideWindow ? (
              <>
                <div className="today-nowtag" aria-hidden="true">
                  {formatTime(now, zone, false)}
                </div>
                <div className="today-now" aria-hidden="true" />
              </>
            ) : null}
            {groupMachines(machines).map((machine) => {
              const inUse = live.has(machine.id);
              const down = machine.status !== "available";
              const own = bookings.filter((booking) => booking.equipmentId === machine.id);
              const status = machineStatus(own, now, zone, inUse, down);
              const blocks = own
                .map((booking) => bookingBlock(booking, window, now, zone, inUse, down))
                .filter((block) => block !== null);
              return (
                <div key={machine.id} className={`today-row${machine.lastOfType ? " today-row--group-end" : ""}`}>
                  <div className="today-machine">
                    {machine.image ? (
                      <img src={machine.image} alt="" />
                    ) : (
                      <span className="today-machine-placeholder">
                        <Drill aria-hidden="true" />
                      </span>
                    )}
                    <div className="today-machine-text">
                      <div className="today-machine-line" title={`${machine.name}, ${machine.type}`}>
                        <span className="today-machine-name">{machine.name}</span>
                        <span className="today-machine-type">{machine.type}</span>
                      </div>
                      <div className={`today-status${inUse ? " today-status--live" : down ? " today-status--down" : ""}`}>
                        {down ? <Wrench aria-hidden="true" /> : <i className="today-dot" aria-hidden="true" />}
                        {status.statusText}
                      </div>
                      <div className="today-next">{status.nextText}</div>
                    </div>
                  </div>
                  <div className="today-track" role="list" aria-label={`${machine.name} bookings today`}>
                    {/* No status-change time is recorded, so an outage covers the whole day. */}
                    {down ? <div className="today-outage" style={{ left: "0%", width: "100%" }} aria-hidden="true" /> : null}
                    {blocks.map((block) => (
                      <div
                        key={block.id}
                        role="listitem"
                        className={`today-block today-block--${block.kind}`}
                        style={{ left: `${block.left * 100}%`, width: `${block.width * 100}%` }}
                        title={block.label}
                        aria-label={block.label}
                      >
                        {block.text}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="today-empty">No machines are set up yet.</p>
        )
      ) : null}
    </section>
  );
}

const studioStateText = { rented: "Rented", held: "Held, awaiting payment", open: "Available" };
function StudiosPanel({
  state,
  studios,
}: {
  state: Result<unknown> | undefined;
  studios: ReturnType<typeof studioOccupancy>;
}) {
  const rented = studios.filter((studio) => studio.state === "rented").length;
  return (
    <section className="today-panel" aria-labelledby="today-studios-title">
      <div className="today-panel-head">
        <h2 id="today-studios-title">Studios</h2>
        {!state && studios.length ? (
          <span className="today-count">
            {rented} of {studios.length} rented
          </span>
        ) : null}
        <Link className="today-link" to="/admin/studios">
          View all
          <ChevronRight aria-hidden="true" />
        </Link>
      </div>
      {state ? (
        <LoadState {...state} />
      ) : studios.length ? (
        <div className="today-studios">
          {studios.map((studio) => (
            <div
              key={studio.id}
              className={`today-studio${studio.state === "open" ? " today-studio--open" : studio.state === "held" ? " today-studio--due" : ""}`}
            >
              <span className="today-studio-name">{studio.name}</span>
              {studio.size ? <span className="today-studio-size">{studio.size}</span> : null}
              <span className="today-studio-state">{studioStateText[studio.state]}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="today-empty">No studios are set up yet.</p>
      )}
    </section>
  );
}

function ClassesPanel({ state, report, zone }: { state: Result<unknown> | undefined; report: Report | null; zone?: string }) {
  const classes = (report?.classes ?? []).filter((item) => item.status !== "cancelled");
  return (
    <section className="today-panel" aria-labelledby="today-classes-title">
      <div className="today-panel-head">
        <h2 id="today-classes-title">Classes today</h2>
        {report ? <span className="today-count">{classes.length}</span> : null}
      </div>
      {state || !zone ? (
        state ? <LoadState {...state} /> : null
      ) : (
        <>
          {classes.map((item) => {
            const filled = item.capacity > 0 ? Math.min(100, Math.max(0, (item.enrolled / item.capacity) * 100)) : 0;
            return (
              <div key={item.id} className="today-class">
                <span className="today-class-title">{item.title}</span>
                <div className="today-class-meta">
                  <span>{formatTime(item.startsAt, zone)}</span>
                  <span>{item.enrolled >= item.capacity ? "Full" : `${item.enrolled} of ${item.capacity}`}</span>
                </div>
                <div className="today-bar" role="img" aria-label={`${item.enrolled} of ${item.capacity} places taken`}>
                  <span className="today-bar-fill" style={{ width: `${filled}%` }} />
                </div>
              </div>
            );
          })}
          {classes.length ? null : <p className="today-empty">No classes today.</p>}
          <div className="today-panel-foot">
            <Link className="today-link" to="/classes">
              See all classes
              <ChevronRight aria-hidden="true" />
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

const needsIcons = { waiver: FilePenLine, payment: Banknote, machine: Wrench, training: GraduationCap };
function NeedsPanel({ state, items }: { state: Result<unknown> | undefined; items: NeedsYouItem[] }) {
  return (
    <section className="today-panel" aria-labelledby="today-needs-title">
      <div className="today-panel-head">
        <h2 id="today-needs-title">Needs you</h2>
        {!state && items.length ? <span className="today-count today-count--hot">{items.length}</span> : null}
      </div>
      {state ? (
        <LoadState {...state} />
      ) : items.length ? (
        items.map((item) => {
          const Icon = needsIcons[item.icon];
          return (
            <div key={item.id} className="today-todo">
              <span className={`today-todo-icon${item.alert ? " today-todo-icon--alert" : ""}`} aria-hidden="true">
                <Icon />
              </span>
              <div>
                <span className="today-todo-title">{item.title}</span>
                <p className="today-todo-detail">{item.detail}</p>
                <Link className="today-button" to={item.to}>
                  {item.action}
                </Link>
              </div>
            </div>
          );
        })
      ) : (
        <p className="today-empty">Nothing needs you right now.</p>
      )}
    </section>
  );
}

function CheckedInPanel({ state, report, zone }: { state: Result<unknown> | undefined; report: Report | null; zone?: string }) {
  const [showAll, setShowAll] = useState(false);
  const people = report?.checkedInToday ?? [];
  const count = report?.checkedInTodayCount ?? 0;
  return (
    <section className="today-panel" aria-labelledby="today-checkedin-title">
      <div className="today-panel-head">
        <h2 id="today-checkedin-title">Checked in today</h2>
        {report ? <span className="today-count">{count}</span> : null}
      </div>
      {state || !zone ? (
        state ? <LoadState {...state} /> : null
      ) : (
        <>
          {(showAll ? people : people.slice(0, 6)).map((person) => (
            <div key={`${person.userId}-${person.at}`} className="today-who">
              <span className={`today-avatar today-avatar--${tone(person.userId)}`} aria-hidden="true">
                {initials(person.name)}
              </span>
              <div className="today-who-text">
                <span className="today-who-name">{person.name}</span>
                <span className="today-who-place">{person.location}</span>
              </div>
              <span className="today-who-time">
                {person.method === "nfc" ? (
                  <Nfc role="img" aria-label="Tag at a reader" />
                ) : (
                  <Monitor role="img" aria-label="Member portal" />
                )}
                {formatTime(person.at, zone)}
              </span>
            </div>
          ))}
          {people.length ? null : <p className="today-empty">Nobody has checked in yet today.</p>}
          {people.length > 6 ? (
            <div className="today-panel-foot">
              <button type="button" className="today-link" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show fewer" : `Show all ${people.length}`}
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
