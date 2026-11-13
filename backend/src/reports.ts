import { Router } from "express";
import type { Pool } from "pg";
import { AppError } from "./domain.js";
import { requirePermission } from "./middleware/permissions.js";
import { reportCsv } from "./reports/csv.js";
import { reportPdf } from "./reports/pdf.js";
import { loadReport, parseReportRequest } from "./reports/service.js";

export function reportRoutes(pool: Pool, tz: string) {
  const r = Router();
  r.get(
    ["/admin/reports", "/admin/reports/export"],
    requirePermission(pool, "audit", "read"),
    async (req, res) => {
      const request = parseReportRequest(req.query);
      const data = await loadReport(pool, tz, request);
      if (!req.path.endsWith("/export")) {
        res.json({ data });
        return;
      }
      const { from, to } = request;
      if (req.query.format === "csv")
        res.json({
          data: {
            filename: `arbor-report-${from}-${to}.csv`,
            contentType: "text/csv;charset=utf-8",
            encoding: "text",
            content: reportCsv(data),
          },
        });
      else if (req.query.format === "pdf")
        res.json({
          data: {
            filename: `arbor-report-${from}-${to}.pdf`,
            contentType: "application/pdf",
            encoding: "base64",
            content: reportPdf(data).toString("base64"),
          },
        });
      else throw new AppError(400, "INVALID_FORMAT", "Choose CSV or PDF.");
    },
  );
  return r;
}
