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
      const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
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
