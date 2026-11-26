import { TableScroll } from "../../components/TableScroll";
import type { Report } from "../../lib/reportContracts";
import { MoreLink, Panel, PeriodName, useLimit } from "./parts";
import type { totals } from "./totals";

export function Members({ report: d, t, unitWord }: { report: Report; t: ReturnType<typeof totals>; unitWord: string }) {
  const rows = d.memberships ?? [];
  const { shown, toggle } = useLimit(rows, 10, `${unitWord}s`);
  return (
    <Panel id="reports-members" title={`Members by ${unitWord}`} aside={<MoreLink to="/admin/members">Open Members</MoreLink>}>
      <dl className="analytics-totals">
        <div><dt>Joined</dt><dd>{t.joined}</dd></div>
        <div><dt>Cancelled</dt><dd>{t.cancelled}</dd></div>
        <div><dt>Ended without renewing</dt><dd>{t.ended}</dd></div>
        {/* Live, not tied to the dates above. */}
        <div><dt>Ending in the next 30 days</dt><dd>{d.compliance.membersEndingWithin30Days}</dd></div>
      </dl>
      <TableScroll label="Members by period">
        <table className="data-table reports-table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="table-number">New members</th>
              <th scope="col" className="table-number">Active members</th>
              <th scope="col" className="table-number">Ended without renewing</th>
              <th scope="col" className="table-number">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.period}>
                <td className="reports-nowrap">
                  <PeriodName start={row.period} report={d} />
                </td>
                <td className="table-number">{row.newMembers || <span className="reports-muted">0</span>}</td>
                <td className="table-number">{row.activeMembers}</td>
                <td className="table-number">{row.endedWithoutRenewingMembers || <span className="reports-muted">0</span>}</td>
                <td className="table-number">{row.cancelledMembers || <span className="reports-muted">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {toggle}
      <p className="reports-note">
        Renewals don't count as new members. Ending in the next 30 days counts members, as of now, whose membership runs out with nothing to
        continue it; card memberships set to renew aren't included.
      </p>
    </Panel>
  );
}
