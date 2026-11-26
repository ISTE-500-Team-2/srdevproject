import { TableScroll } from "../../components/TableScroll";
import { statusLabel } from "../../lib/display";
import type { Report } from "../../lib/reportContracts";
import { count, percent } from "./format";
import { Fill, Panel } from "./parts";

const cohortNames: Record<string, string> = {
  expirationCompliance: "Waiver & training expiry",
  membershipExpiration: "Membership expiry",
  other: "Account, billing & other",
};

export function Reminders({ cohorts }: { cohorts: [string, Report["notifications"]["cohorts"][string]][] }) {
  return (
    <Panel id="reports-reminders" title="Reminder emails">
      <p className="reports-note reports-note--top">
        Reminders due in this period. <b>Sent</b>: left our system on time. <b>Delivered</b>: reached the member's inbox on
        time.
      </p>
      <TableScroll label="Reminder emails">
        <table className="data-table reports-table">
          <thead>
            <tr>
              <th scope="col">Reminder</th>
              <th scope="col" className="table-number">Due</th>
              <th scope="col">Sent on time</th>
              <th scope="col">Delivered on time</th>
              <th scope="col" className="table-number">Delivered (any time)</th>
              <th scope="col">Problems</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(([key, row]) => {
              const problems = (
                [
                  [row.failed, "failed to send", "failed to send"],
                  [row.delivery_failed, "bounced", "bounced"],
                  [row.uncertain, "uncertain", "uncertain"],
                  [row.pending, "pending", "pending"],
                ] as const
              ).filter(([count]) => count > 0);
              return (
                <tr key={key}>
                  <th scope="row">{cohortNames[key] ?? statusLabel(key)}</th>
                  <td className="table-number">{row.eligible}</td>
                  <td>
                    <Rate value={row.onTimePercent} count={row.on_time} due={row.eligible} />
                  </td>
                  <td>
                    <Rate value={row.deliveryOnTimePercent} count={row.delivery_on_time} due={row.eligible} />
                  </td>
                  <td className="table-number">{row.delivered}</td>
                  <td>
                    {problems.length ? (
                      <span className="reports-chips">
                        {problems.map(([count, one, many]) => (
                          <span key={one} className="status-pill status-pill--warn">
                            {count} {count === 1 ? one : many}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="reports-muted">None</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

function Rate({ value, count: n, due }: { value: number | null; count: number; due: number }) {
  if (value === null) return <span className="reports-muted">None due</span>;
  return (
    <span className="reports-rate">
      <Fill value={value} />
      <span>
        <b>{percent(value)}</b> <small>{count(n)} of {count(due)}</small>
      </span>
    </span>
  );
}
