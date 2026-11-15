import { EXPORT_ROW_SECTIONS, EXPORT_SUMMARY_SECTIONS } from "./sections.js";
import type { ReportData } from "./types.js";

/** The report as text lines, one record per line, fields separated by " | ". */
function reportLines(d: ReportData): string[] {
  const rows: string[][] = [
    ["Report", `${d.from} through ${d.to}`, d.timeZone, d.generatedAt],
    ...d.notes.map((x) => ["Method", x]),
  ];
  for (const section of EXPORT_ROW_SECTIONS)
    for (const row of d[section])
      rows.push([
        section,
        ...Object.entries(row).map(([k, v]) => `${k}: ${v ?? "not recorded"}`),
      ]);
  for (const section of EXPORT_SUMMARY_SECTIONS)
    rows.push([
      section,
      ...Object.entries(d[section]).map(([k, v]) => `${k}: ${v}`),
    ]);
  for (const [cohort, metrics] of Object.entries(d.notifications.cohorts))
    rows.push([
      "notifications",
      cohort,
      ...Object.entries(metrics).map(
        ([k, v]) => `${k}: ${v ?? "not measured"}`,
      ),
    ]);
  return rows.map((x) => x.join(" | "));
}

export function reportPdf(data: ReportData): Buffer {
  return pdfReport(reportLines(data));
}

/** A minimal single-font PDF 1.4 document; non-ASCII becomes spaces, lines wrap at 95 characters. */
function pdfReport(lines: string[]): Buffer {
  const wrapped = lines.flatMap((line) => {
    const clean = line.replace(/[^\x20-\x7e]/g, " ");
    return clean.match(/.{1,95}/g) ?? [""];
  });
  const pages = [];
  for (let i = 0; i < wrapped.length; i += 47)
    pages.push(wrapped.slice(i, i + 47));
  const objects: string[] = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const ids: number[] = [];
  for (const lines of pages) {
    const id = objects.length + 1,
      contentId = id + 1;
    ids.push(id);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream =
      "BT /F1 9 Tf 36 756 Td 15 TL " +
      lines
        .map(
          (line, i) =>
            (i ? "T* " : "") +
            "(" +
            line
              .replaceAll("\\", "\\\\")
              .replaceAll("(", "\\(")
              .replaceAll(")", "\\)") +
            ") Tj",
        )
        .join("\n") +
      " ET";
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${ids.map((id) => id + " 0 R").join(" ")}] /Count ${ids.length} >>`;
  let out = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
