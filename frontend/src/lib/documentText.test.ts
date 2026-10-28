import { expect, test } from "vitest";
import JSZip from "jszip";
import { documentText } from "./documentText";

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
  await expect(documentText(new File(["x"], "scan.pdf"))).rejects.toThrow(/PDFs can't be read/);
  await expect(documentText(new File(["x"], "photo.png", { type: "image/png" }))).rejects.toThrow(/Word \(\.docx\) or text/);
  await expect(documentText(new File(["   "], "blank.txt", { type: "text/plain" }))).rejects.toThrow(/empty/);
});
