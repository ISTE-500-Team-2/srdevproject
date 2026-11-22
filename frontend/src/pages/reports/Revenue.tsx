import { TableScroll } from "../../components/TableScroll";
import { dollars, statusLabel } from "../../lib/display";
import type { Report } from "../../lib/reportContracts";
import { count, money } from "./format";
import { MoreLink, Panel, PeriodName, useLimit } from "./parts";
import type { totals } from "./totals";

export function Revenue({ report: d, t }: { report: Report; t: ReturnType<typeof totals> }) {
  const { shown, toggle } = useLimit(d.revenue, 10, "rows");
  return (
    <Panel id="reports-revenue" title="Revenue" aside={<MoreLink to="/admin/payments">Open Payments</MoreLink>}>
      <dl className="analytics-totals">
        <div><dt>Net</dt><dd>{money(t.net)}</dd></div>
        <div><dt>Gross</dt><dd>{money(t.gross)}</dd></div>
        <div><dt>Refunded</dt><dd>{money(t.refunds)}</dd></div>
        <div><dt>Receipts</dt><dd>{count(t.receipts)}</dd></div>
      </dl>
      {d.revenue.length ? (
        <>
          <TableScroll label="Revenue rows">
            <table className="data-table reports-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Category</th>
                  <th scope="col">Method</th>
                  <th scope="col" className="table-number">Receipts</th>
                  <th scope="col" className="table-number">Gross</th>
                  <th scope="col" className="table-number">Refunded</th>
                  <th scope="col" className="table-number">Net</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {/* Name a period once; its other rows sit under it. */}
                    <td className={i && shown[i - 1].period === r.period ? "reports-nowrap reports-repeat" : "reports-nowrap"}>
                      <PeriodName start={r.period} report={d} />
                    </td>
                    <td>{r.category}</td>
                    <td>{statusLabel(r.method)}</td>
                    <td className="table-number">{r.receipts}</td>
                    <td className="table-number">{dollars(r.gross)}</td>
                    <td className="table-number">{Number(r.refunds) ? dollars(r.refunds) : <span className="reports-muted">—</span>}</td>
                    <td className="table-number">{dollars(r.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>Total</th>
                  <td className="table-number">{count(t.receipts)}</td>
                  <td className="table-number">{money(t.gross)}</td>
                  <td className="table-number">{t.refunds ? money(t.refunds) : <span className="reports-muted">—</span>}</td>
                  <td className="table-number">{money(t.net)}</td>
                </tr>
              </tfoot>
            </table>
          </TableScroll>
          {toggle}
        </>
      ) : (
        <p className="reports-empty">No payments in this period.</p>
      )}
    </Panel>
  );
}
