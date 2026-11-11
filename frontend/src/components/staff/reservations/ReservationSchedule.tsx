import { useState, type CSSProperties, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Drill, Wrench } from "lucide-react";
import { LoadState } from "../../Management";
import type { LiveEquipment, Reservation } from "../../../lib/contracts";
import { formatTime, groupMachines, machineStatus, shortName, timeWindow } from "../../../lib/today";
import { dayLabel, isFree, scheduleKind, slotAt, timeRange } from "../../../lib/reservationSchedule";

const HOUR = 3_600_000;
type LoadResult = { loading: boolean; error: string; reload: () => void };

const kindLabel = { live: "in use now", booked: "booked", hold: "awaiting payment", conflict: "affected by outage", past: "finished" } as const;

/** One day of reservations per machine, built from Today's timeline classes. A booking opens its details; open time starts a new booking. */
export function ReservationSchedule({
  day,
  today,
  zone,
  now,
  machines,
  bookings,
  live,
  state,
  selectedId,
  onOpen,
  onCreate,
  onNotice,
}: {
  day: string;
  today: string;
  zone: string;
  now: number;
  machines: LiveEquipment[];
  bookings: Reservation[];
  live: Set<number | null>;
  state: LoadResult | undefined;
  selectedId: number | null;
  onOpen: (reservation: Reservation) => void;
  onCreate: (equipmentId: number, start: number) => void;
  onNotice: (message: string) => void;
}) {
  const [hover, setHover] = useState<{ machine: number; at: number } | null>(null);
  const window = timeWindow(now, zone, bookings, day);
  const span = window.end - window.start;
  const isToday = day === today;
  const place = (start: number, end: number) => ({
    left: `${((Math.max(start, window.start) - window.start) / span) * 100}%`,
    width: `${((Math.min(end, window.end) - Math.max(start, window.start)) / span) * 100}%`,
  });
  const pointAt = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return slotAt((event.clientX - box.left) / box.width, window);
  };
  const openTime = (machine: LiveEquipment, own: Reservation[], at: number) =>
    machine.status === "available" && at > now && isFree(at, at + HOUR, own);

  return (
    <section className="today-panel res-schedule" aria-labelledby="res-schedule-title">
      <div className="today-panel-head">
        <h2 id="res-schedule-title">{dayLabel(day, today)}</h2>
        {!state ? <span className="today-count">{bookings.length}</span> : null}
        <div className="today-legend" role="list" aria-label="Timeline key">
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--live" aria-hidden="true" />
            In use now
          </span>
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--booked" aria-hidden="true" />
            Booked
          </span>
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch res-swatch--hold" aria-hidden="true" />
            Awaiting payment
          </span>
          <span className="today-legend-item" role="listitem">
            <i className="today-swatch today-swatch--down" aria-hidden="true" />
            Out of service
          </span>
        </div>
      </div>
      {state ? <LoadState {...state} /> : null}
      {!state ? (
        machines.length ? (
          <div className="res-schedule__scroll">
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
              {isToday && window.nowInsideWindow ? (
                <>
                  <div className="today-nowtag" aria-hidden="true">
                    {formatTime(now, zone, false)}
                  </div>
                  <div className="today-now" aria-hidden="true" />
                </>
              ) : null}
              {groupMachines(machines).map((machine) => {
                const own = bookings.filter((booking) => booking.equipmentId === machine.id);
                const inUse = isToday && live.has(machine.id);
                const down = machine.status !== "available";
                const status = isToday
                  ? machineStatus(own, now, zone, inUse, down).statusText
                  : down
                    ? "Out of service"
                    : own.length
                      ? `${own.length} ${own.length === 1 ? "reservation" : "reservations"}`
                      : "Nothing booked";
                const ghost = hover?.machine === machine.id ? hover.at : null;
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
                          <Link className="today-machine-name" to={`/admin/equipment/${machine.id}`}>
                            {machine.name}
                          </Link>
                          <span className="today-machine-type">{machine.type}</span>
                        </div>
                        <div className={`today-status${inUse ? " today-status--live" : down ? " today-status--down" : ""}`}>
                          {down ? <Wrench aria-hidden="true" /> : <i className="today-dot" aria-hidden="true" />}
                          {status}
                        </div>
                      </div>
                    </div>
                    <div
                      className={`today-track res-track${down ? " res-track--down" : ""}`}
                      role="group"
                      aria-label={`${machine.name}, ${dayLabel(day, today)}`}
                      onMouseMove={(event) => {
                        if ((event.target as HTMLElement).closest(".res-block")) return setHover(null);
                        const at = pointAt(event);
                        setHover(openTime(machine, own, at) ? { machine: machine.id, at } : null);
                      }}
                      onMouseLeave={() => setHover(null)}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest(".res-block")) return;
                        const at = pointAt(event);
                        if (down) return onNotice(`${machine.name} is out of service.`);
                        if (at <= now) return onNotice("That time has already passed.");
                        if (!isFree(at, at + HOUR, own)) return onNotice("That time is already reserved.");
                        onCreate(machine.id, at);
                      }}
                    >
                      {(machine.outages?.length
                        ? machine.outages
                        : down
                          ? [{ startedAt: new Date(window.start).toISOString(), endedAt: null }]
                          : []
                      ).map((outage, index) => {
                        const start = Math.max(window.start, Date.parse(outage.startedAt));
                        const end = Math.min(window.end, outage.endedAt ? Date.parse(outage.endedAt) : window.end);
                        return end > start ? <div key={index} className="today-outage" style={place(start, end)} aria-hidden="true" /> : null;
                      })}
                      {own.map((booking) => {
                        const kind = scheduleKind(booking, now, inUse, down);
                        const start = Date.parse(booking.startTime), end = Date.parse(booking.endTime);
                        const name = booking.memberName ?? `Member #${booking.userId}`;
                        const label = `${name}, ${timeRange(start, end, zone)}, ${kindLabel[kind]}`;
                        return (
                          <button
                            key={booking.id}
                            type="button"
                            className={`today-block today-block--${kind === "hold" ? "booked" : kind} res-block${kind === "hold" ? " res-block--hold" : ""}${selectedId === booking.id ? " is-selected" : ""}`}
                            style={place(start, end)}
                            title={label}
                            aria-label={label}
                            aria-current={selectedId === booking.id ? "true" : undefined}
                            onClick={() => onOpen(booking)}
                          >
                            {shortName(name)}
                          </button>
                        );
                      })}
                      {ghost !== null ? (
                        <div className="res-ghost" style={place(ghost, Math.min(ghost + HOUR, window.end))} aria-hidden="true">
                          + {formatTime(ghost, zone, false)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="today-empty">No machines are set up yet.</p>
        )
      ) : null}
      <div className="today-panel-foot res-schedule__foot">
        <span>Studio and room bookings are managed in Studios.</span>
        <Link className="today-link" to="/admin/studios">
          Open Studios
          <ChevronRight aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
