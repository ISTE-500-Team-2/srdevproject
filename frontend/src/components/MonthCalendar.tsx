import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, calendarDate, nextMonth } from "../lib/studioDisplay";
import "./monthCalendar.css";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function MonthCalendar({
  month,
  setMonth,
  today,
  selected,
  isValid,
  onSelect,
}: {
  month: string;
  setMonth: (month: string) => void;
  today: string;
  selected: string;
  isValid: (date: string) => boolean;
  onSelect: (date: string) => void;
}) {
  const first = month + "-01";
  const lead = new Date(first + "T00:00:00Z").getUTCDay();
  const count = Number(addDays(nextMonth(first), -1).slice(8, 10));
  const shift = (by: number) => {
    const d = new Date(first + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + by);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <div className="studio-cal">
      <div className="studio-cal__head">
        <strong>{calendarDate(first, { month: "long", year: "numeric" })}</strong>
        <span>
          <button
            type="button"
            className="icon-button"
            aria-label="Previous month"
            disabled={month <= today.slice(0, 7)}
            onClick={() => shift(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next month"
            onClick={() => shift(1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="studio-cal__grid" role="group" aria-label="Start date">
        {WEEKDAYS.map((d) => (
          <span key={d} className="studio-cal__dow" aria-hidden="true">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={"lead" + i} />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const valid = date >= today && isValid(date);
          return (
            <button
              key={date}
              type="button"
              className={"studio-cal__day" + (date >= today && !valid ? " studio-cal__day--unavailable" : "")}
              aria-label={calendarDate(date) + (date >= today && !valid ? ": unavailable" : "")}
              aria-pressed={date === selected}
              disabled={!valid}
              onClick={() => onSelect(date)}
            >
              <span>{i + 1}</span>
              {date >= today && !valid && <span className="studio-cal__unavailable-mark" aria-hidden="true">×</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

