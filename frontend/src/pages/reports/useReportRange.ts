// The report's range and grouping (kept in the URL), the two report reads and the export download.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../../lib/api";
import { previousRange, type Preset, type Range } from "../../lib/analytics";
import type { Report } from "../../lib/reportContracts";
import { useApi } from "../../lib/useApi";
import { checkRange, readParams } from "./params";

export function useReportRange(today: string) {
  const [params, setParams] = useSearchParams();
  const { preset, range } = readParams(params, today);
  // The date boxes may hold a half-typed range; only a valid one reaches the URL.
  const [draft, setDraft] = useState(range);
  const [validation, setValidation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "csv" | "pdf">("");
  const query = new URLSearchParams(range).toString();
  // Back and forward change the URL, not the boxes: follow them.
  useEffect(() => setDraft(range), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new range keeps the last report on screen, faded, until the new one lands.
  const report = useApi<Report>("/admin/reports?" + query, { retainOnReload: true, retainOnChange: true, refreshInterval: 30000 });
  const previous = useApi<Report>("/admin/reports?" + new URLSearchParams(previousRange(range, preset)), {
    retainOnReload: true,
  });

  const apply = (next: Range, nextPreset: Preset = preset) => {
    setDraft(next);
    try {
      checkRange(next);
    } catch (error) {
      setValidation((error as Error).message);
      return;
    }
    setValidation("");
    const search = new URLSearchParams(params);
    search.set("range", nextPreset);
    search.set("group", next.period);
    if (nextPreset === "custom") {
      search.set("from", next.from);
      search.set("to", next.to);
    } else {
      search.delete("from");
      search.delete("to");
    }
    setParams(search, { replace: true });
  };

  async function download(format: "csv" | "pdf") {
    setBusy(format);
    setMessage("");
    try {
      const result = await api<{ filename: string; contentType: string; encoding: string; content: string }>(
        "/admin/reports/export?" + query + "&format=" + format,
      );
      const content =
        result.encoding === "base64" ? Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0)) : result.content;
      const url = URL.createObjectURL(new Blob([content], { type: result.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const d = report.data;
  const stale = Boolean(report.stale);
  const expected = d ? previousRange(d, preset) : null;
  const before =
    previous.data && expected && previous.data.from === expected.from && previous.data.to === expected.to
      ? previous.data
      : undefined;
  return { preset, range, draft, validation, message, busy, apply, download, report, d, stale, before };
}
