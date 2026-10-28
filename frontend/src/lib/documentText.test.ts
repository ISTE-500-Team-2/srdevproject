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

/** Real small PDF with a proper object table, exercising PDF.js rather than a parser mock. */
function pdfFile(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (const text of pages) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const escaped = text.replace(/[\\()]/g, "\\$&");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
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

test("explains a scanned/image-only PDF without silently importing an empty waiver", async () => {
  await expect(documentText(pdfFile([""]))).rejects.toThrow(/no selectable text.*OCR/);
});

test("rejects oversized documents before parsing", async () => {
  const file = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "large.pdf");
  await expect(documentText(file)).rejects.toThrow(/over 5 MB/);
});
