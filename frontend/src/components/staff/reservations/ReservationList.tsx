import { Fragment } from "react";
import type { LiveEquipment, Reservation } from "../../../lib/contracts";
import { cents } from "../../../lib/display";
import { dayKey } from "../../../lib/today";
import { bookedCents, dayLabel, hoursLabel, isRoom, reservationHours, reservationStatus, timeRange } from "../../../lib/reservationSchedule";

/** Reservations as a table grouped by day, in the Payments table's style. A row opens its reservation beside the list. */
export function ReservationList({
  items,
  zone,
  now,
  today,
  machines,
  selectedId,
  caption,
  onOpen,
}: {
  items: Reservation[];
  zone: string;
  now: number;
  today: string;
  machines: LiveEquipment[];
  selectedId: number | null;
  caption: string;
  onOpen: (reservation: Reservation) => void;
}) {
  const down = new Set(machines.filter((machine) => machine.status !== "available").map((machine) => machine.id));
  let previous = "";
  return (
    <div className="res-table table-scroll" role="region" aria-label="Reservations" tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Equipment</th>
            <th scope="col">Member</th>
            <th scope="col">Status</th>
            <th scope="col" className="res-table__amount">
              Price
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const day = dayKey(Date.parse(item.startTime), zone);
            const heading = day !== previous;
            previous = day;
            const status = reservationStatus(item, now, item.equipmentId !== null && down.has(item.equipmentId));
            const price = bookedCents(item);
            const room = isRoom(item);
            const hours = reservationHours(item);
            return (
              <Fragment key={item.id}>
                {heading ? (
                  <tr className="res-table__day">
                    <th scope="rowgroup" colSpan={5}>
                      {dayLabel(day, today)}
                    </th>
                  </tr>
                ) : null}
                <tr className={selectedId === item.id ? "is-selected" : undefined} onClick={() => onOpen(item)}>
                  <td>
                    <button
                      type="button"
                      className="res-table__open"
                      aria-current={selectedId === item.id ? "true" : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(item);
                      }}
                    >
                      {timeRange(item.startTime, item.endTime, zone)}
                    </button>
                    <small>
                      {hoursLabel(hours)} · #{item.id}
                    </small>
                  </td>
                  <td>
                    <span className="res-table__main">{item.equipmentName}</span>
                    <small>{room ? "Studio or room" : item.location}</small>
                  </td>
                  <td>
                    <span className="res-table__main">{item.memberName ?? `Member #${item.userId}`}</span>
                    <small>{item.memberEmail ?? `#${item.userId}`}</small>
                  </td>
                  <td>
                    <span className={`status-pill status-pill--${status.tone}`}>{status.label}</span>
                  </td>
                  <td className="res-table__amount">{price == null ? "—" : cents(price)}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
