import { useState } from "react";
import { ChevronLeft, ChevronRight, Hourglass, Lock } from "lucide-react";
import type { Rental, Studio } from "../../lib/studioContracts";
import {
  daysBetween,
  memberName,
  monthStarts,
  openGaps,
  rentalFor,
  studioNow,
  timelineBars,
  type StudioState,
} from "../../lib/studioDesk";
import {
  SIZE_ORDER,
  addDays,
  calendarDate,
  dateOnly,
  money,
  sizeKey,
  sizeLabel,
  studioImage,
} from "../../lib/studioDisplay";

const DAYS = 90;
// The desktop window starts a little before today so the current rentals read in context.
const LEAD = 13;
const short = (d: string) =>
  calendarDate(d, { month: "short", day: "numeric" });
const pct = (days: number) => `${(days / DAYS) * 100}%`;

export function holdDate(at: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(Date.parse(at));
}

/** One line on where a studio stands today, e.g. "Dana Whitfield · through Nov 30". */
export function statusLine(
  s: Studio,
  today: string,
  rentals: Rental[],
  timeZone: string,
): { state: StudioState; text: string } {
  const { state, current, next } = studioNow(s, today);
  if (current) {
    const who = memberName(rentalFor(s, current, rentals));
    return state === "rented"
      ? {
          state,
          text: `${who} · through ${short(addDays(dateOnly(current.ends_on), -1))}`,
        }
      : {
          state,
          text: `Held for ${who} · pay by ${holdDate(current.hold_until, timeZone)}`,
        };
  }
  if (state === "off") return { state, text: "Not offered to members" };
  if (next)
    return {
      state,
      text: `Open now · ${next.status === "pending" ? "held" : "booked"} from ${short(next.starts_on)}`,
    };
  return { state, text: "Open now" };
}

type Filter = "all" | "open" | "rented" | "off";
const filters: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open now" },
  { key: "rented", label: "Rented" },
  { key: "off", label: "Not offered" },
];

/** Every studio with who has it and a 3-month timeline; click one to open its sheet. */
export function OccupancyBoard({
  studios,
  rentals,
  today,
  timeZone,
  canEdit,
  onOpen,
}: {
  studios: Studio[];
  rentals: Rental[];
  today: string;
  timeZone: string;
  canEdit: boolean;
  onOpen: (id: number) => void;
}) {
  const [shift, setShift] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const start = addDays(today, shift * 30 - LEAD);
  const todayAt = daysBetween(start, today);
  const states = new Map(
    studios.map((s) => [s.id, statusLine(s, today, rentals, timeZone)]),
  );
  const count = (key: Filter) =>
    key === "all"
      ? studios.length
      : studios.filter(
          (s) =>
            states.get(s.id)!.state === key ||
            (key === "rented" && states.get(s.id)!.state === "held"),
        ).length;
  const shown = studios.filter(
    (s) =>
      filter === "all" ||
      states.get(s.id)!.state === filter ||
      (filter === "rented" && states.get(s.id)!.state === "held"),
  );
  const groups = [...SIZE_ORDER, "other"]
    .map((size) => ({
      size,
      items: shown.filter((s) =>
        SIZE_ORDER.includes(sizeKey(s.size))
          ? sizeKey(s.size) === size
          : size === "other",
      ),
    }))
    .filter((g) => g.items.length);

  return (
    <section
      className="desk-panel desk-board"
      aria-labelledby="desk-board-title"
    >
      <div className="desk-panel__head">
        <h2 id="desk-board-title">Occupancy</h2>
        <span className="desk-count">{studios.length} studios</span>
        <div className="desk-range">
          <button
            type="button"
            className="desk-icon-button"
            aria-label="Earlier month"
            onClick={() => setShift(shift - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <span aria-live="polite">
            {short(start)} – {short(addDays(start, DAYS - 1))}
          </span>
          <button
            type="button"
            className="desk-icon-button"
            aria-label="Later month"
            onClick={() => setShift(shift + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button button--quiet desk-small"
            disabled={!shift}
            onClick={() => setShift(0)}
          >
            Today
          </button>
        </div>
        <div className="desk-legend" aria-hidden="true">
          <span>
            <i className="desk-swatch desk-swatch--booked" />
            Booked
          </span>
          <span>
            <i className="desk-swatch desk-swatch--held" />
            Held for payment
          </span>
          <span>
            <i className="desk-swatch desk-swatch--off" />
            Not offered
          </span>
        </div>
      </div>
      <div className="desk-filters" role="group" aria-label="Show studios">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            className="desk-chip"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <em>{count(f.key)}</em>
          </button>
        ))}
      </div>
      <div className="desk-strip-legend" aria-hidden="true">
        <span>
          <i className="desk-swatch desk-swatch--booked" />
          Booked
        </span>
        <span>
          <i className="desk-swatch desk-swatch--held" />
          Held for payment
        </span>
        <span>
          <i className="desk-swatch desk-swatch--free" />
          Free
        </span>
      </div>
      <div
        className="desk-board__body"
        style={{ ["--desk-today" as string]: todayAt / DAYS }}
      >
        <div className="desk-axis" aria-hidden="true">
          <span />
          <div className="desk-ticks">
            {monthStarts(start, DAYS)
              .filter((m) => Math.abs(m.offset - todayAt) > 5)
              .map((m) => (
                <span key={m.date} style={{ left: pct(m.offset) }}>
                  {calendarDate(m.date, { month: "short", day: "numeric" })}
                </span>
              ))}
            {todayAt >= 0 && todayAt < DAYS ? (
              <span className="desk-today-tag" style={{ left: pct(todayAt) }}>
                Today
              </span>
            ) : null}
          </div>
        </div>
        <div className="desk-strip-axis" aria-hidden="true">
          <span>Today</span>
          {monthStarts(today, DAYS)
            .filter((m) => m.offset > 8)
            .map((m) => (
              <span key={m.date} style={{ left: pct(m.offset) }}>
                {calendarDate(m.date, { month: "short" })}
              </span>
            ))}
        </div>
        {groups.length ? null : <p className="desk-empty">No studios match.</p>}
        {groups.map((group) => (
          <div key={group.size} className="desk-group">
            <h3 className="desk-group__label">
              {group.size === "other" ? "Other" : sizeLabel(group.size)}
            </h3>
            <ul>
              {group.items.map((s) => {
                const { state, text } = states.get(s.id)!;
                const bars = timelineBars(s, start, DAYS);
                return (
                  <li key={s.id} className="desk-row">
                    <button
                      type="button"
                      className="desk-row__name"
                      onClick={() => onOpen(s.id)}
                    >
                      <img src={studioImage(s.size)} alt="" />
                      <span className="desk-row__text">
                        <span className="desk-row__title">
                          {s.name}
                          <small>
                            {s.monthly_cents
                              ? `${money(s.monthly_cents)} / mo`
                              : "No rate"}
                          </small>
                        </span>
                        <span className={`desk-state desk-state--${state}`}>
                          <span
                            className="desk-state__dot"
                            aria-hidden="true"
                          />
                          {text}
                        </span>
                      </span>
                    </button>
                    <div className="desk-track" onClick={() => onOpen(s.id)}>
                      {monthStarts(start, DAYS).map((m) => (
                        <span
                          key={m.date}
                          className="desk-track__month"
                          style={{ left: pct(m.offset) }}
                        />
                      ))}
                      {state === "off" ? (
                        <div className="desk-bar desk-bar--off">
                          <Lock aria-hidden="true" />
                          No rate or terms yet. Members can't book it.
                          {canEdit ? (
                            <button
                              type="button"
                              className="button button--quiet desk-small"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpen(s.id);
                              }}
                            >
                              Set rate
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          {bars.map((bar) => {
                            const rental = rentalFor(s, bar.slot, rentals);
                            const held = bar.slot.status === "pending";
                            return (
                              <div
                                key={bar.slot.starts_on}
                                className={`desk-bar desk-bar--${held ? "held" : "booked"}${bar.clipped ? " desk-bar--clipped" : ""}`}
                                style={{
                                  left: pct(bar.from),
                                  width: `calc(${pct(bar.to - bar.from)} - 3px)`,
                                }}
                                title={`${memberName(rental)}: ${short(bar.slot.starts_on)} – ${short(addDays(dateOnly(bar.slot.ends_on), -1))}`}
                              >
                                {held ? <Hourglass aria-hidden="true" /> : null}
                                {memberName(rental)}
                                {held ? (
                                  <span className="desk-bar__note">
                                    pay by{" "}
                                    {holdDate(bar.slot.hold_until, timeZone)}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                          {openGaps(bars, DAYS, todayAt)
                            .filter((gap) => gap.to - gap.from >= 6)
                            .map((gap) => (
                              <span
                                key={gap.from}
                                className="desk-open"
                                style={{ left: pct(gap.from) }}
                              >
                                Open
                              </span>
                            ))}
                        </>
                      )}
                      {todayAt >= 0 && todayAt < DAYS ? (
                        <span
                          className="desk-track__today"
                          style={{ left: pct(todayAt) }}
                        />
                      ) : null}
                    </div>
                    <Strip studio={s} today={today} />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Phone view of the timeline: the next 90 days under each studio. */
function Strip({ studio, today }: { studio: Studio; today: string }) {
  const off = studioNow(studio, today).state === "off";
  return (
    <div
      className={`desk-strip${off ? " desk-strip--off" : ""}`}
      aria-hidden="true"
    >
      {off
        ? null
        : timelineBars(studio, today, DAYS).map((bar) => (
            <i
              key={bar.slot.starts_on}
              className={
                bar.slot.status === "pending" ? "desk-strip__held" : undefined
              }
              style={{ left: pct(bar.from), width: pct(bar.to - bar.from) }}
            />
          ))}
      {monthStarts(today, DAYS).map((m) => (
        <u key={m.date} style={{ left: pct(m.offset) }} />
      ))}
    </div>
  );
}
