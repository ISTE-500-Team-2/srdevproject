import { expect, test } from "vitest";
import JSZip from "jszip";
import { documentText, MAX_DOCUMENT_BYTES } from "./documentText";

/** A minimal real .docx: two paragraphs. */
async function docx(paragraphs: string[]) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new File([bytes], "Waiver.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

test("reads the text out of a Word document, paragraph by paragraph", async () => {
  const text = await documentText(await docx(["Terms of Service", "Members agree to follow posted safety rules."]));
  expect(text).toBe("Terms of Service\n\nMembers agree to follow posted safety rules.");
});

test("reads plain text and tidies line endings and blank runs", async () => {
  const file = new File(["Rule one.  \r\n\r\n\r\n\r\nRule two.\r\n"], "rules.txt", { type: "text/plain" });
  expect(await documentText(file)).toBe("Rule one.\n\nRule two.");
});

test("explains files it can't read instead of failing silently", async () => {
  await expect(documentText(new File(["x"], "old.doc"))).rejects.toThrow(/save it as \.docx/);
  await expect(documentText(new File(["x"], "broken.pdf"))).rejects.toThrow(/PDF could not be read/);
  await expect(documentText(new File(["x"], "photo.png", { type: "image/png" }))).rejects.toThrow(/PDF.*Word.*text/);
  await expect(documentText(new File(["   "], "blank.txt", { type: "text/plain" }))).rejects.toThrow(/empty/);
});

test("a .docx that isn't really a Word file gets advice, not the unzip error", async () => {
  // An old .doc or a PDF renamed to .docx: mammoth's unzip step fails with a developer link.
  // The .doc sample is raw bytes, so it starts with the real OLE signature rather than UTF-8 text.
  const oldWord = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new TextEncoder().encode(" old Word binary")]);
  for (const bytes of ["%PDF-1.4 not a zip", oldWord]) {
    const error = await documentText(new File([bytes], "waiver.docx")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "This Word file could not be read. Re-save it as .docx from Word, upload a PDF, or paste the wording.",
    );
  }
});

/**
 * Real small PDF with a proper object table, exercising PDF.js rather than a parser mock. A page is
 * plain text, or [text, bold, x?] runs that switch fonts mid-line the way styled wording does; a run
 * with an x is placed at that point on the same line instead of following the one before it.
 */
type Run = [text: string, bold: boolean, x?: number];
function pdfFile(pages: (string | Run[])[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  const kids: string[] = [];
  for (const text of pages) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const runs: Run[] = typeof text === "string" ? [[text, false]] : text;
    const shown = runs
      .map(([run, bold, x]) => `/F${bold ? 2 : 1} 12 Tf ${x === undefined ? "" : `1 0 0 1 ${x} 720 Tm `}(${run.replace(/[\\()]/g, "\\$&")}) Tj`)
      .join(" ");
    const stream = `BT 72 720 Td ${shown} ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([pdf], "waiver.pdf", { type: "application/pdf" });
}

test("extracts all pages of a real PDF in order", async () => {
  expect(await documentText(pdfFile(["Terms of Service", "Follow the posted safety rules."])))
    .toBe("Terms of Service\n\nFollow the posted safety rules.");
});

test("bold phrases in a PDF keep single spaces and no space before punctuation", async () => {
  const page: Run[] = [
    ["Members agree to ", false],
    ["wear eye protection", true],
    [". Always ", false],
    ["sign in", true],
    [", then work.", false],
  ];
  expect(await documentText(pdfFile([page]))).toBe("Members agree to wear eye protection. Always sign in, then work.");
});

test("a line drawn out of order in a PDF still gets a space between its words", async () => {
  // PDF.js emits no space item when text jumps back left on the same line.
  expect(await documentText(pdfFile([[["second", false, 200], ["first", false, 72]]]))).toBe("second first");
});

test("explains a scanned/image-only PDF without silently importing an empty waiver", async () => {
  await expect(documentText(pdfFile([""]))).rejects.toThrow(/no selectable text.*OCR/);
});

test("rejects oversized documents before parsing", async () => {
  const file = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "large.pdf");
  await expect(documentText(file)).rejects.toThrow(/over 5 MB/);
});
