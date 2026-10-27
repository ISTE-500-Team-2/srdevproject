import { Ban, CalendarPlus, ClipboardCheck, MoreHorizontal, Plus, Search, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DateRail, SeatMeter } from "./ClassBits";
import { byStart, hasStarted, isCancelled, seatTone, timeRange, type ClassRecord } from "./classData";
import { shortDate } from "../../lib/display";

type Tab = "upcoming" | "attendance" | "past" | "cancelled";

export function ClassSchedule({
  classes,
  pending,
  canRecord,
  onSchedule,
  onScheduleAgain,
  onCancel,
  onRoster,
}: {
  classes: ClassRecord[];
  /** People still marked "registered" on a past class's roster, by class id. */
  pending: Record<number, number>;
  canRecord: (c: ClassRecord) => boolean;
  onSchedule: () => void;
  onScheduleAgain: (c: ClassRecord) => void;
  onCancel: (c: ClassRecord) => void;
  onRoster: (c: ClassRecord) => void;
}) {
  const [tab, setTab] = useState<Tab>("upcoming");
  const [query, setQuery] = useState("");
  const groups: Record<Tab, ClassRecord[]> = {
    upcoming: classes.filter((c) => !isCancelled(c) && !hasStarted(c)).sort(byStart),
    attendance: classes.filter((c) => !isCancelled(c) && (pending[c.id] ?? 0) > 0).sort(byStart),
    past: classes.filter((c) => !isCancelled(c) && hasStarted(c)).sort((a, b) => byStart(b, a)),
    cancelled: classes.filter(isCancelled).sort((a, b) => byStart(b, a)),
  };
  const needle = query.trim().toLowerCase();
  const rows = groups[tab].filter(
    (c) => !needle || `${c.title} ${c.instructor} ${c.certificationName} ${c.roomName}`.toLowerCase().includes(needle),
  );
  const mineToRecord = groups.attendance.filter(canRecord);
  const first = mineToRecord[0];
  const tabs: [Tab, string][] = [
    ["upcoming", "Upcoming"],
    ["attendance", "Needs attendance"],
    ["past", "Past"],
    ["cancelled", "Cancelled"],
  ];
  return (
    <>
      <div className="classes-head">
        <div>
          <p className="eyebrow">Training</p>
          <h1 className="display-heading">Classes</h1>
        </div>
        <div className="classes-head__tools">
          <label className="class-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search classes</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search classes" />
          </label>
          <button type="button" className="button button--primary" onClick={onSchedule}>
            <Plus aria-hidden="true" />
            Schedule class
          </button>
        </div>
      </div>

      {first ? (
        <div className="class-banner class-banner--attention">
          <span className="class-banner__icon" aria-hidden="true">
            <ClipboardCheck />
          </span>
          <div>
            <b>
              {mineToRecord.length === 1
                ? `${first.title} (${shortDate(first.startsAt)}) needs attendance.`
                : `${mineToRecord.length} past classes need attendance.`}
            </b>
            <span>
              {mineToRecord.length === 1
                ? `${pending[first.id]} ${pending[first.id] === 1 ? "person on the roster has" : "people on the roster have"} no attendance recorded yet.`
                : "People on these rosters have no attendance recorded yet."}
            </span>
          </div>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => (mineToRecord.length === 1 ? onRoster(first) : setTab("attendance"))}
          >
            Record attendance
          </button>
        </div>
      ) : null}

      <div className="class-tabs" role="tablist" aria-label="Class lists">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={key === "attendance" && groups.attendance.length ? "class-tab class-tab--attention" : "class-tab"}
            onClick={() => setTab(key)}
          >
            {label}
            {key !== "past" && groups[key].length ? <em>{groups[key].length}</em> : null}
          </button>
        ))}
      </div>

      <div className="class-table" role="tabpanel">
        <div className="class-table__row class-table__head" aria-hidden="true">
          <span>Date</span>
          <span>Class</span>
          <span>Instructor</span>
          <span>Room</span>
          <span>Seats</span>
          <span>Status</span>
          <span />
        </div>
        {rows.length ? (
          rows.map((c) => (
            <ScheduleRow
              key={c.id}
              c={c}
              pending={pending[c.id]}
              onRoster={onRoster}
              onScheduleAgain={onScheduleAgain}
              onCancel={onCancel}
            />
          ))
        ) : (
          <p className="class-table__empty">
            {needle
              ? "No classes match your search."
              : tab === "upcoming"
                ? "No upcoming classes. Use Schedule class to add one."
                : tab === "attendance"
                  ? "Every past class has its attendance recorded."
                  : tab === "past"
                    ? "No past classes yet."
                    : "No cancelled classes."}
          </p>
        )}
      </div>
    </>
  );
}

function statusOf(c: ClassRecord, pending: number | undefined) {
  if (isCancelled(c)) return { label: "Cancelled", tone: "danger" };
  if (hasStarted(c))
    return pending ? { label: "Needs attendance", tone: "warn" } : { label: pending === 0 ? "Recorded" : "Past", tone: "neutral" };
  const tone = seatTone(c);
  return tone === "full" ? { label: "Full", tone: "neutral" } : tone === "hot" ? { label: "Almost full", tone: "warn" } : { label: "Open", tone: "ok" };
}

function ScheduleRow({
  c,
  pending,
  onRoster,
  onScheduleAgain,
  onCancel,
}: {
  c: ClassRecord;
  pending: number | undefined;
  onRoster: (c: ClassRecord) => void;
  onScheduleAgain: (c: ClassRecord) => void;
  onCancel: (c: ClassRecord) => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);
  const status = statusOf(c, pending);
  const cancellable = !isCancelled(c) && !hasStarted(c);
  return (
    <div className={`class-table__row${isCancelled(c) ? " class-table__row--cancelled" : ""}`}>
      <DateRail value={c.startsAt} faded={isCancelled(c)} />
      <div className="class-table__class">
        <h3>{c.title}</h3>
        <span className="class-cert">{c.certificationName}</span>
        <small>
          {shortDate(c.startsAt)} · {timeRange(c)}
        </small>
      </div>
      <span>{c.instructor}</span>
      <span>{c.roomName}</span>
      <SeatMeter capacity={c.capacity} enrolled={c.enrolled} compact />
      <span>
        <span className={`status-pill status-pill--${status.tone}`}>{status.label}</span>
      </span>
      <div className="class-table__actions" ref={menuRef}>
        <button type="button" className="button button--quiet button--small" aria-label={`Roster for ${c.title}`} onClick={() => onRoster(c)}>
          <Users aria-hidden="true" />
          Roster
        </button>
        <button
          type="button"
          className="button button--quiet button--small button--icon"
          aria-label={`More actions for ${c.title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
        {menu ? (
          <div className="class-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onScheduleAgain(c);
              }}
            >
              <CalendarPlus aria-hidden="true" />
              Schedule again…
            </button>
            {cancellable ? (
              <button
                type="button"
                role="menuitem"
                className="class-menu__danger"
                onClick={() => {
                  setMenu(false);
                  onCancel(c);
                }}
              >
                <Ban aria-hidden="true" />
                Cancel class…
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
