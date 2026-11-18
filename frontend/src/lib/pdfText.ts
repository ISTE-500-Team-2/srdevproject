import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

/** Text-only PDF import; no embedded scripts, attachments or external URLs are opened. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    // Vite emits a same-origin, version-matched worker; no third-party CDN.
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  }
  const loading = pdfjs.getDocument({
    data: bytes,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: true,
  });
  try {
    const document = await loading.promise;
    if (document.numPages > 100) throw new Error("That PDF has over 100 pages. Import only the waiver pages.");
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = joinRuns(content.items);
      pages.push(text);
      page.cleanup();
      // Bound extraction too: a small compressed PDF can contain enormous text.
      if (pages.reduce((sum, value) => sum + value.length, 0) > 200000)
        throw new Error("That PDF contains too much text. Import only the waiver pages.");
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (!text.trim()) throw new Error("This PDF has no selectable text. It may be a scan; run OCR first, or upload a Word document or paste the wording.");
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error("This PDF is password-protected. Upload an unlocked copy to import its text.");
    if (error instanceof Error && ["InvalidPDFException", "UnknownErrorException"].includes(error.name))
      throw new Error("This PDF could not be read. Try a new PDF export, a Word document, or paste the wording.", { cause: error });
    throw error;
  } finally {
    await loading.destroy();
  }
}

/**
 * PDF.js already emits the spaces between runs as their own items, so adding one after every item
 * would double them and put a space before punctuation after bold text. Its one gap is a line drawn
 * out of order: a run placed left of where the previous run ended gets no space, so add it there.
 */
function joinRuns(items: (TextItem | TextMarkedContent)[]) {
  let text = "";
  let previous: TextItem | undefined;
  for (const item of items) {
    if (!("str" in item)) continue;
    if (previous && startsBehind(item, previous) && /\S$/.test(text) && /^\S/.test(item.str)) text += " ";
    text += item.str + (item.hasEOL ? "\n" : "");
    previous = item;
  }
  return text.trim();
}

/**
 * Whether a left-to-right run starts back on the same line, left of where the previous one ended.
 * The thresholds match PDF.js's own: it starts a new line past half a font height of vertical
 * shift, and it splits a run only when text steps back by more than a fifth of the font size.
 */
function startsBehind(run: TextItem, previous: TextItem) {
  const level = (r: TextItem) => r.dir === "ltr" && r.transform[0] > 0 && r.transform[1] === 0;
  if (!level(run) || !level(previous)) return false;
  const size = Math.max(run.height, previous.height);
  return Math.abs(run.transform[5] - previous.transform[5]) <= size / 2
    && run.transform[4] < previous.transform[4] + previous.width - size / 5;
}
