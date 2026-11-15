import { EXPORT_ROW_SECTIONS, EXPORT_SUMMARY_SECTIONS } from "./sections.js";
import type { ReportData } from "./types.js";

function csvCell(s: string) {
  const safe = /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replaceAll('"', '""') + '"';
}

/** One CSV table: a `section` column plus the union of every record's keys. */
export function reportCsv(data: ReportData): string {
  const records: Record<string, unknown>[] = [
    {
      section: "metadata",
      from: data.from,
      to: data.to,
      timeZone: data.timeZone,
      generatedAt: data.generatedAt,
    },
    ...data.notes.map((note) => ({ section: "method", note })),
  ];
  for (const section of EXPORT_ROW_SECTIONS)
    for (const row of data[section]) records.push({ section, ...row });
  for (const section of EXPORT_SUMMARY_SECTIONS)
    records.push({ section, ...data[section] });
  for (const [cohort, metrics] of Object.entries(data.notifications.cohorts))
    records.push({ section: "notifications", cohort, ...metrics });
  const headers = [...new Set(records.flatMap((row) => Object.keys(row)))];
  return [
    headers,
    ...records.map((row) => headers.map((key) => String(row[key] ?? ""))),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
