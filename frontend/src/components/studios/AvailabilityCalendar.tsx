import { useState } from "react";
import type { Studio } from "../../lib/studioContracts";
import { dateOnly } from "../../lib/studioDisplay";

export function AvailabilityCalendar({
  studios,
  selectedStart,
  onSelect,
}: {
  studios: Studio[];
  selectedStart: string;
  onSelect: (value: string) => void;
}) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return (
    <section aria-label="All studios monthly calendar">
      <label>
        Calendar month{" "}
        <input
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </label>
      <p>
        Available dates are buttons. A free day is not a guarantee that the full
        rental month is available; review the space below.
      </p>
      <div className="studio-calendar-scroll">
        <table className="studio-calendar">
          <caption>{month}: studio occupancy (H = hold, B = booked)</caption>
          <thead>
            <tr>
              <th scope="col">Studio</th>
              {Array.from({ length: count }, (_, i) => (
                <th key={i} scope="col">
                  {i + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {studios.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                {Array.from({ length: count }, (_, i) => {
                  const date = `${month}-${String(i + 1).padStart(2, "0")}`;
                  const occupied = s.availability.find(
                    (r) =>
                      dateOnly(r.starts_on) <= date &&
                      dateOnly(r.ends_on) > date,
                  );
                  return (
                    <td key={date}>
                      {occupied ? (
                        <abbr title={`${s.name} ${date}: ${occupied.status}`}>
                          {occupied.status === "pending" ? "H" : "B"}
                        </abbr>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Select ${date} for ${s.name}`}
                          aria-pressed={date === selectedStart}
                          onClick={() => onSelect(date)}
                        >
                          ·
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
