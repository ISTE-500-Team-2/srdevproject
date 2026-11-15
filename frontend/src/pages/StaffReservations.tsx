import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ChartGantt, ChevronLeft, ChevronRight, List, Plus, Search, X } from "lucide-react";
import { LoadState, Pager } from "../components/Management";
import { Toast } from "../components/Toast";
import { ReservationSchedule } from "../components/staff/reservations/ReservationSchedule";
import { ReservationList } from "../components/staff/reservations/ReservationList";
import { NeedsPanel, ReservationDetails, ReservationEditor, usePanelFocus, type EditorStart } from "../components/staff/reservations/ReservationPanel";
import type { LiveEquipment, Reservation } from "../lib/contracts";
import type { Page } from "../lib/staffContracts";
import { useApi } from "../lib/useApi";
import { addDays, dayKey, localHour, mergeBookings, previousDay } from "../lib/today";
import { dayLabel, timeRange } from "../lib/reservationSchedule";
import { useDayBookings } from "./admin/useDayBookings";
import type { Report } from "../lib/reportContracts";

const refresh = { retainOnReload: true, refreshInterval: 60000 };
const positive = (value: string | null) => (Number(value) > 0 ? Number(value) : null);

type View = "schedule" | "list";
// `opened` tells two forms apart, so starting a new one never keeps the last one's entries.
type Panel = { kind: "needs" } | { kind: "details"; reservation: Reservation } | { kind: "edit"; from: EditorStart; opened: number };

/** Staff reservations: one day's schedule by machine, or a searchable list, with the selected reservation beside it. */
export function StaffReservations() {
  const config = useApi<{ timeZone: string }>("/config", { ...refresh, reuse: true });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const zone = config.data?.timeZone;
  if (!zone)
    return (
      <div className="today eq-workspace res-page">
        <Heading summary="" />
        <LoadState loading={config.loading} error={config.error} reload={config.reload} />
      </div>
    );
  return <Workspace zone={zone} now={now} />;
}

function Heading({ summary }: { summary: string }) {
  return (
    <header className="eq-heading res-heading">
      <div>
        <p className="eq-eyebrow">Operations</p>
        <h1 className="admin-title">Reservations</h1>
        {summary ? <p className="res-summary">{summary}</p> : null}
      </div>
    </header>
  );
}

function Workspace({ zone, now }: { zone: string; now: number }) {
  const [params, setParams] = useSearchParams();
  // A member's account and a machine's page link here to show their reservations.
  const linkedMember = positive(params.get("member"));
  const linkedEquipment = positive(params.get("equipmentId"));
  const linked = !!(linkedMember || linkedEquipment);
  const today = dayKey(now, zone);
  const [view, setView] = useState<View>(linked ? "list" : "schedule");
  const [viewBeforeSearch, setViewBeforeSearch] = useState<View | null>(null);
  const [day, setDay] = useState(today);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [when, setWhen] = useState<"upcoming" | "past">("upcoming");
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [offset, setOffset] = useState(0);
  const [panel, setPanel] = useState<Panel>({ kind: "needs" });
  const [toast, setToast] = useState<string | null>(null);
  const opened = useRef(0);
  // The panel on screen now, so a save or cancel that finishes after staff moved on leaves their new panel alone.
  const currentPanel = useRef(panel);
  currentPanel.current = panel;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const equipment = useApi<LiveEquipment[]>("/equipment", refresh);
  const machines = equipment.data ?? [];
  const dayBookings = useDayBookings(day, refresh);
  const eveBookings = useDayBookings(previousDay(day), refresh);
  const dayStart = localHour(day, 0, zone);
  const bookings = mergeBookings(dayBookings.bookings, eveBookings.bookings.filter((b) => Date.parse(b.endTime) > dayStart));
  const failed = dayBookings.failed ?? eveBookings.failed;
  const scheduleState = !equipment.data
    ? { loading: equipment.loading, error: equipment.error, reload: equipment.reload }
    : failed
      ? { loading: false, error: `This day’s reservations could not be loaded. ${failed.error}`, reload: failed.reload }
      : (dayBookings.state ?? eveBookings.state);

  // Machines in use now come from the readers, as on Today.
  const report = useApi<Report>(day === today ? `/admin/reports?period=daily&from=${today}&to=${today}` : null, refresh);
  const live = new Set(
    report.data?.live
      .filter((lease) => lease.kind === "equipment" && lease.activeReaderLeases > 0 && lease.resourceId !== null)
      .map((lease) => lease.resourceId),
  );

  const listQuery = new URLSearchParams({ offset: String(offset), when });
  if (query) listQuery.set("search", query);
  if (includeCancelled) listQuery.set("includeCancelled", "true");
  if (linkedMember) listQuery.set("userId", String(linkedMember));
  if (linkedEquipment) listQuery.set("equipmentId", String(linkedEquipment));
  const list = useApi<Page<Reservation>>(view === "list" ? `/admin/reservations?${listQuery}` : null, refresh);

  const reloadAll = () => {
    dayBookings.reload();
    eveBookings.reload();
    list.reload();
  };
  // The newest copy of a reservation by revision: the panel's own (a save's result) or one from a later read.
  // A read that hasn't caught up with a save must not bring back the old time.
  const latest = (r: Reservation) =>
    [bookings.find((b) => b.id === r.id), list.data?.items.find((b) => b.id === r.id)].reduce<Reservation>(
      (best, copy) => (copy && copy.revision >= best.revision ? copy : best),
      r,
    );
  const shown = panel.kind === "details" ? latest(panel.reservation) : null;
  const panelKey = panel.kind === "needs" ? "needs" : panel.kind === "details" ? `details-${panel.reservation.id}` : `edit-${panel.opened}`;
  const panelTitle = usePanelFocus(panelKey);

  const open = (reservation: Reservation) => setPanel({ kind: "details", reservation });
  const edit = (from: EditorStart) => setPanel({ kind: "edit", from, opened: ++opened.current });
  const startNew = (from: Partial<EditorStart> = {}) => edit({ day: day < today ? today : day, ...from });
  const closePanel = () => setPanel({ kind: "needs" });
  const showView = (next: View) => {
    setView(next);
    setViewBeforeSearch(null);
  };
  const onSearch = (value: string) => {
    setSearch(value);
    // Searching looks across every day, so it shows the list; clearing it goes back.
    if (value.trim() && view !== "list") {
      setViewBeforeSearch(view);
      setView("list");
    } else if (!value.trim() && viewBeforeSearch) {
      setView(viewBeforeSearch);
      setViewBeforeSearch(null);
    }
  };
  const clearLink = () => {
    const next = new URLSearchParams(params);
    next.delete("member");
    next.delete("equipmentId");
    setParams(next, { replace: true });
    setOffset(0);
  };

  const monday = addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const starting = bookings.filter((b) => dayKey(Date.parse(b.startTime), zone) === day);
  const down = new Set(machines.filter((m) => m.status !== "available").map((m) => m.id));
  const affected = starting.filter((b) => b.equipmentId !== null && down.has(b.equipmentId) && Date.parse(b.endTime) > now).length;
  const summary =
    view !== "schedule" || scheduleState
      ? ""
      : [
          `${starting.length} ${starting.length === 1 ? "reservation" : "reservations"} ${day === today ? "today" : `on ${dayLabel(day, today).replace(/^(Today|Tomorrow), /, "")}`}`,
          day === today ? `${live.size} ${live.size === 1 ? "machine" : "machines"} in use now` : "",
          affected ? `${affected} affected by an outage` : "",
        ]
          .filter(Boolean)
          .join(" · ") + ".";
  const memberName = list.data?.items.find((r) => r.userId === linkedMember)?.memberName;
  const machineName = machines.find((m) => m.id === linkedEquipment)?.name;
  const items = list.data?.items ?? [];

  const onDay = (key: string) => (key === today ? "today" : key === addDays(today, 1) ? "tomorrow" : `on ${dayLabel(key, today, "short")}`);
  const onPanelKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && panel.kind !== "needs") closePanel();
  };

  return (
    <div className="today eq-workspace res-page">
      {dayBookings.loaders}
      {eveBookings.loaders}
      <Heading summary={summary} />
      <div className="eq-toolbar res-toolbar">
        <label className="eq-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Find a member or machine</span>
          <input type="search" placeholder="Find a member or machine…" value={search} onChange={(event) => onSearch(event.target.value)} />
        </label>
        <div className="eq-filters" role="group" aria-label="View">
          <button type="button" className="eq-filter" aria-pressed={view === "schedule"} onClick={() => showView("schedule")}>
            <ChartGantt aria-hidden="true" /> Schedule
          </button>
          <button type="button" className="eq-filter" aria-pressed={view === "list"} onClick={() => showView("list")}>
            <List aria-hidden="true" /> List
          </button>
        </div>
        <button type="button" className="button button--primary" onClick={() => startNew()}>
          <Plus aria-hidden="true" /> New reservation
        </button>
      </div>

      {view === "schedule" ? (
        <nav className="res-week" aria-label="Choose a day">
          <div className="res-week__strip">
          <button type="button" className="res-week__step" aria-label="Previous week" onClick={() => setDay(addDays(day, -7))}>
            <ChevronLeft aria-hidden="true" />
          </button>
          {week.map((d) => (
            <button key={d} type="button" className="res-week__day" aria-current={d === day ? "date" : undefined} aria-label={dayLabel(d, today)} onClick={() => setDay(d)}>
              <span>{d === today ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${d}T12:00:00Z`))}</span>
              <b>{Number(d.slice(8))}</b>
            </button>
          ))}
          <button type="button" className="res-week__step" aria-label="Next week" onClick={() => setDay(addDays(day, 7))}>
            <ChevronRight aria-hidden="true" />
          </button>
          </div>
          {!week.includes(today) ? (
            <button type="button" className="button button--quiet res-week__today" onClick={() => setDay(today)}>
              Back to today
            </button>
          ) : null}
        </nav>
      ) : (
        <div className="res-listbar">
          <div className="eq-filters" role="group" aria-label="Show">
            {(["upcoming", "past"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="eq-filter"
                aria-pressed={when === value}
                onClick={() => {
                  setWhen(value);
                  setOffset(0);
                }}
              >
                {value === "upcoming" ? "Upcoming" : "Past"}
              </button>
            ))}
          </div>
          <label className="res-check">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(event) => {
                setIncludeCancelled(event.target.checked);
                setOffset(0);
              }}
            />
            Include cancelled
          </label>
          {linked ? (
            <span className="res-filter">
              {linkedMember ? `${memberName ?? `Member #${linkedMember}`}’s reservations` : `${machineName ?? `Machine #${linkedEquipment}`} reservations`}
              <button type="button" className="icon-button icon-button--small" aria-label="Show all reservations" onClick={clearLink}>
                <X aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      )}

      <div className="res-split">
        <div className="res-main">
          {view === "schedule" ? (
            <ReservationSchedule
              day={day}
              today={today}
              zone={zone}
              now={now}
              machines={machines}
              bookings={bookings}
              live={live}
              state={scheduleState}
              selectedId={panel.kind === "details" ? panel.reservation.id : null}
              onOpen={open}
              onCreate={(equipmentId, start) => startNew({ equipmentId, start, day })}
              onNotice={setToast}
            />
          ) : (
            <>
              <LoadState loading={list.loading && !list.data} error={list.error} reload={list.reload} />
              {list.data ? (
                items.length ? (
                  <ReservationList
                    items={items}
                    zone={zone}
                    now={now}
                    today={today}
                    machines={machines}
                    selectedId={panel.kind === "details" ? panel.reservation.id : null}
                    caption={`${when === "upcoming" ? "Upcoming" : "Past"} reservations ${offset + 1}–${offset + items.length}`}
                    onOpen={open}
                  />
                ) : (
                  <div className="res-empty">
                    <p>{query ? `No ${when} reservations match “${query}”.` : `No ${when} reservations.`}</p>
                    {query ? (
                      <button type="button" className="button button--quiet" onClick={() => onSearch("")}>
                        Clear search
                      </button>
                    ) : null}
                  </div>
                )
              ) : null}
              {list.data ? <Pager offset={offset} nextOffset={list.data.nextOffset} onChange={setOffset} /> : null}
            </>
          )}
        </div>
        <aside className="today-panel res-panel" aria-label="Reservation" onKeyDown={onPanelKey}>
          {panel.kind === "needs" ? (
            <NeedsPanel day={day} today={today} zone={zone} now={now} bookings={starting} machines={machines} loading={!!scheduleState} onOpen={open} />
          ) : shown ? (
            <ReservationDetails
              key={shown.id}
              reservation={shown}
              machine={machines.find((m) => m.id === shown.equipmentId)}
              zone={zone}
              now={now}
              today={today}
              titleRef={panelTitle}
              onClose={closePanel}
              onChange={() => edit({ reservation: shown, day: dayKey(Date.parse(shown.startTime), zone) })}
              onCancelled={(r) => {
                setToast(`Reservation #${r.id} cancelled.`);
                reloadAll();
                if (currentPanel.current === panel) closePanel();
              }}
            />
          ) : panel.kind === "edit" ? (
            <ReservationEditor
              key={panelKey}
              from={panel.from}
              machines={machines}
              zone={zone}
              now={now}
              today={today}
              titleRef={panelTitle}
              onClose={() => (panel.from.reservation ? open(panel.from.reservation) : closePanel())}
              onSaved={(r, created) => {
                const when = timeRange(r.startTime, r.endTime, zone);
                setToast(
                  created
                    ? `Booked ${r.equipmentName} for ${r.memberName ?? `member #${r.userId}`}, ${when}.`
                    : `Moved to ${r.equipmentName} ${onDay(dayKey(Date.parse(r.startTime), zone))}, ${when}.`,
                );
                reloadAll();
                if (currentPanel.current !== panel) return;
                if (view === "schedule") setDay(dayKey(Date.parse(r.startTime), zone));
                open(r);
              }}
            />
          ) : null}
        </aside>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
