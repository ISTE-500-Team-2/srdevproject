/** Largest document we'll read in the browser. Waiver text is capped at 16,000 characters anyway. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const extension = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** Tidy extracted text: unify line endings, drop trailing spaces and runs of blank lines. */
function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Reads text from PDF, Word (.docx) or plain-text files, entirely in the
 * browser. Only the text is used; the file itself is not uploaded or kept.
 */
export async function documentText(file: File): Promise<string> {
  const ext = extension(file.name);
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error("That file is over 5 MB. Use a smaller document.");
  if (ext === "doc")
    throw new Error("Older .doc files can't be read. Open it in Word, save it as .docx, and try again.");
  if (ext === "pdf" || file.type === "application/pdf") {
    const { pdfText } = await import("./pdfText");
    return tidy(await pdfText(new Uint8Array(await file.arrayBuffer())));
  }
  if (ext === "docx") {
    // mammoth is only needed here, so it loads on first use.
    const mammoth = await import("mammoth");
    const bytes = await file.arrayBuffer();
    // The browser build reads `arrayBuffer`; the Node build (tests) reads `buffer`.
    const { value } = await mammoth.extractRawText({
      arrayBuffer: bytes,
      buffer: new Uint8Array(bytes),
    } as unknown as { arrayBuffer: ArrayBuffer });
    const text = tidy(value);
    if (!text) throw new Error("That document has no text in it.");
    return text;
  }
  if (ext === "txt" || ext === "md" || file.type.startsWith("text/")) {
    const text = tidy(await file.text());
    if (!text) throw new Error("That file is empty.");
    return text;
  }
  throw new Error("Upload a PDF (.pdf), Word (.docx) or text (.txt) file.");
}
