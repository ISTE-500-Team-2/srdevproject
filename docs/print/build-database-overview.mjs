// Build this overview with Node.js and Chrome/Chromium; no npm packages required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'docs/SPONSOR-DATABASE-OVERVIEW.md');
const output = path.join(root, 'docs/print/ARBOR-Database-Overview');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arbor-database-docs-'));
const repository = `https://github.com/ISTE-500-Team-2/srdevproject/blob/${encodeURIComponent(process.env.ARBOR_DOCS_REF || 'main')}/`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function findChrome() {
  const candidates = [process.env.CHROME_BIN];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('Set CHROME_BIN to your Chrome/Chromium executable. See DATABASE-OVERVIEW-BUILD.md.');
  return found;
}

const chrome = findChrome();
function browser(args) {
  const result = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--user-data-dir=${path.join(work, 'profile')}`, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`Browser export failed: ${result.error?.message || result.stderr}`);
}

// Preserve relative navigation in Markdown; exported files use repository URLs.
function target(href) {
  if (/^(?:[a-z][\w+.-]*:|#)/i.test(href)) return href;
  const [file, anchor] = href.split('#');
  const relative = path.posix.normalize(`docs/${file}`);
  if (relative.startsWith('../')) throw new Error(`Link outside repository: ${href}`);
  return repository + relative + (anchor ? `#${anchor}` : '');
}

// Deliberately limited to the Markdown constructs used by this document.
function parse(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line === '<!-- pagebreak -->') { blocks.push({ type: 'break' }); i++; continue; }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (line.startsWith('```')) {
      const content = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) content.push(lines[i]);
      blocks.push({ type: 'code', text: content.join('\n') }); i++; continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (image) { blocks.push({ type: 'image', alt: image[1], href: image[2] }); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i++].split('|').slice(1, -1).map(cell => cell.trim());
        if (!cells.every(cell => /^:?-+:?$/.test(cell))) rows.push(cells);
      }
      blocks.push({ type: 'table', rows }); continue;
    }
    const list = /^(?:- |(\d+)\. )(.+)$/.exec(line);
    if (list) { blocks.push({ type: 'list', number: list[1], text: list[2] }); i++; continue; }
    const content = [];
    while (i < lines.length && lines[i].trim()) {
      content.push(lines[i++]);
      if (content.at(-1).endsWith('  ')) break;
    }
    blocks.push({ type: 'paragraph', text: content.join(' ').trim() });
  }
  return blocks;
}

const blocks = parse(fs.readFileSync(source, 'utf8'));
const inlinePattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\[(\d+(?:, \d+)*)\]/g;
function htmlInline(text) {
  let result = '', previous = 0;
  for (const match of text.matchAll(inlinePattern)) {
    result += xml(text.slice(previous, match.index));
    if (match[1]) result += `<a href="${xml(target(match[2]))}">${xml(match[1])}</a>`;
    else if (match[3]) result += `<strong>${xml(match[3])}</strong>`;
    else if (match[4]) result += `<code>${xml(match[4])}</code>`;
    else result += '[' + match[5].split(', ').map(n => `<a href="#reference-${n}">${n}</a>`).join(', ') + ']';
    previous = match.index + match[0].length;
  }
  return result + xml(text.slice(previous));
}

const relationships = [];
function relate(type, href) {
  const id = `rId${relationships.length + 1}`;
  relationships.push({ id, type, href });
  return id;
}
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
function wordInline(text, properties = '') {
  let result = '', previous = 0;
  const linkRun = label => run(label, properties + '<w:color w:val="865020"/><w:u w:val="single"/>');
  for (const match of text.matchAll(inlinePattern)) {
    result += run(text.slice(previous, match.index), properties);
    if (match[1]) {
      const id = relate('hyperlink', target(match[2]));
      result += `<w:hyperlink r:id="${id}">${linkRun(match[1])}</w:hyperlink>`;
    } else if (match[3]) result += run(match[3], properties + '<w:b/>');
    else if (match[4]) result += run(match[4], properties + '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/>');
    else result += run('[') + match[5].split(', ').map(n => `<w:hyperlink w:anchor="reference_${n}">${linkRun(n)}</w:hyperlink>`).join(run(', ')) + run(']');
    previous = match.index + match[0].length;
  }
  return result + run(text.slice(previous), properties);
}
function paragraph(content, style = '', extra = '') {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${content}</w:p>`;
}

// A small standards-compliant ZIP writer keeps Word generation dependency-free.
function zip(entries) {
  const parts = [], directory = [];
  let offset = 0;
  function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  for (const [name, data] of entries) {
    const filename = Buffer.from(name), raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = deflateRawSync(raw), crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(header, filename, compressed); directory.push(central, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22), centralSize = directory.reduce((sum, part) => sum + part.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

try {
  const diagram = fs.readFileSync(path.join(root, 'docs/assets/database-account-map.svg'));
  const diagramPage = path.join(work, 'diagram.html'), diagramPng = path.join(work, 'diagram.png');
  fs.writeFileSync(diagramPage, `<html><style>*{margin:0}img{display:block;width:1200px;height:340px}</style><img src="data:image/svg+xml;base64,${diagram.toString('base64')}"></html>`);
  browser(['--window-size=1200,340', '--force-device-scale-factor=1', `--screenshot=${diagramPng}`, pathToFileURL(diagramPage).href]);
  const png = fs.readFileSync(diagramPng);
  const imageId = relate('image', 'media/account-map.png');
  const html = [], word = [];
  for (const block of blocks) {
    if (block.type === 'break') {
      html.push('<div class="pagebreak"></div>'); word.push(paragraph('<w:r><w:br w:type="page"/></w:r>')); continue;
    }
    if (block.type === 'heading') {
      html.push(`<h${block.level}>${htmlInline(block.text)}</h${block.level}>`);
      word.push(paragraph(wordInline(block.text), `Heading${block.level}`)); continue;
    }
    if (block.type === 'image') {
      if (block.href !== 'assets/database-account-map.svg') throw new Error(`Unsupported image: ${block.href}`);
      html.push(`<figure><img alt="${xml(block.alt)}" src="data:image/png;base64,${png.toString('base64')}"></figure>`);
      word.push(paragraph(`<w:r><w:drawing><wp:inline><wp:extent cx="6310000" cy="1787833"/><wp:docPr id="1" name="Account relationships" descr="${xml(block.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="account-map.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${imageId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6310000" cy="1787833"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`)); continue;
    }
    if (block.type === 'code') {
      html.push(`<pre>${xml(block.text)}</pre>`);
      for (const line of block.text.split('\n')) word.push(paragraph(run(line), 'Code')); continue;
    }
    if (block.type === 'table') {
      html.push('<table><thead><tr>' + block.rows[0].map(cell => `<th>${htmlInline(cell)}</th>`).join('') + '</tr></thead><tbody>' + block.rows.slice(1).map(row => '<tr>' + row.map(cell => `<td>${htmlInline(cell)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      const widths = block.rows[0].length === 3 ? [2400, 3100, 4480] : [2700, 7280];
      word.push('<w:tbl><w:tblPr><w:tblW w:w="9980" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>' + ['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="D7DDD4"/>`).join('') + '</w:tblBorders><w:tblCellMar><w:top w:w="85" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="85" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + widths.map(width => `<w:gridCol w:w="${width}"/>`).join('') + '</w:tblGrid>' + block.rows.map((row, index) => `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>` + row.map((cell, column) => `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="17422F"/>' : ''}<w:vAlign w:val="top"/></w:tcPr>` + paragraph(wordInline(cell, index === 0 ? '<w:b/><w:color w:val="FFFFFF"/>' : ''), 'TableText') + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>'); continue;
    }
    if (block.type === 'list') {
      const label = block.number ? `${block.number}. ` : '• ';
      const bookmark = block.number ? `<w:bookmarkStart w:id="${100 + Number(block.number)}" w:name="reference_${block.number}"/>` : '';
      html.push(`<p class="list"${block.number ? ` id="reference-${block.number}"` : ''}>${label}${htmlInline(block.text)}</p>`);
      word.push(paragraph(bookmark + run(label) + wordInline(block.text) + (block.number ? `<w:bookmarkEnd w:id="${100 + Number(block.number)}"/>` : ''), 'List')); continue;
    }
    html.push(`<p>${htmlInline(block.text)}</p>`); word.push(paragraph(wordInline(block.text)));
  }
  const css = fs.readFileSync(path.join(root, 'docs/print/sponsor.css'), 'utf8') + '\nbody{font-size:10pt;line-height:1.42}.pagebreak{break-before:page}h2{margin-top:0}p{margin:0 0 9px}h1{font-size:29pt}table{font-size:8.5pt}td,th{padding:4px;overflow-wrap:anywhere}td p{margin:0}.list{padding-left:18px;text-indent:-18px}figure{margin:8px 0}';
  const htmlFile = `${output}.html`;
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>ARBOR Database Overview</title><style>${css}</style></head><body>${html.join('\n')}</body></html>`);
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="263D32"/><w:sz w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="125" w:line="265" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1,2,3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 0 : 200}" w:after="140"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="17422F"/><w:sz w:val="${[58,36,25][level - 1]}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="230" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="17"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:fill="F4F1E9"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="240" w:hanging="240"/></w:pPr></w:style></w:styles>`;
  relate('styles', 'styles.xml');
  const footerId = relate('footer', 'footer.xml');
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const doc = declaration + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${word.join('')}<w:sectPr><w:footerReference w:type="default" r:id="${footerId}"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1077" w:right="963" w:bottom="1077" w:left="963" w:header="400" w:footer="450"/></w:sectPr></w:body></w:document>`;
  const rels = declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + relationships.map(({id,type,href}) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xml(href)}"${type === 'hyperlink' ? ' TargetMode="External"' : ''}/>`).join('') + '</Relationships>';
  const footer = declaration + `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph(run('ARBOR Database Overview  ·  ') + '<w:fldSimple w:instr="PAGE"/>', '', '<w:jc w:val="right"/>')}</w:ftr>`;
  fs.writeFileSync(`${output}.docx`, zip([
    ['[Content_Types].xml', declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'],
    ['_rels/.rels', declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc], ['word/styles.xml', declaration + styles], ['word/_rels/document.xml.rels', rels],
    ['word/footer.xml', footer], ['word/media/account-map.png', png],
  ]));
  browser(['--no-pdf-header-footer', `--print-to-pdf=${output}.pdf`, pathToFileURL(htmlFile).href]);
  if (!fs.existsSync(`${output}.pdf`) || fs.statSync(`${output}.pdf`).size === 0) throw new Error('PDF export did not create a file.');
  console.log('Generated docs/print/ARBOR-Database-Overview.{html,docx,pdf}');
} finally {
  if (path.dirname(path.resolve(work)) !== path.resolve(os.tmpdir()) || !path.basename(work).startsWith('arbor-database-docs-')) {
    throw new Error('Refusing to clean up an unexpected temporary directory.');
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
