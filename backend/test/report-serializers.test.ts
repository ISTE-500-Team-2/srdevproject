import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { reportCsv } from '../src/reports/csv.js';
import { reportPdf } from '../src/reports/pdf.js';
import { reportFixture } from './helpers/reportFixture.js';

// Date cells render in the report's time zone, so a different server zone must not matter.
process.env.TZ = 'Asia/Tokyo';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Golden hashes were produced by the serializers as they were inlined in
// reports.ts before the export code moved to src/reports (commit 7c3d7a2),
// then updated when dates began rendering as local "YYYY-MM-DD HH:mm".
test('CSV export is byte-identical to the original serializer', () => {
  const csv = reportCsv(reportFixture());
  const lines = csv.split('\r\n');
  assert.ok(lines[0]!.startsWith('"section","from","to","timeZone","generatedAt","note","period","category"'));
  assert.ok(csv.includes(`"'=SUM(A1:A9)","card"`), 'formula-looking cells are neutralized');
  assert.ok(csv.includes('"He said ""hi"" (twice) \\ back"'), 'quotes are doubled');
  assert.ok(csv.includes('"2030-01-02 10:00"'), 'class start in New York time, not Date#toString');
  assert.equal(lines.length, 62, 'header, metadata, 3 notes, 52 section rows, 2 summaries, 3 cohorts');
  assert.equal(sha256(csv), 'df300b13a47aad6296259dc0b79ecfcee0f22d94ec73ca816d388059ca446fe7');
});

test('PDF export is byte-identical to the original serializer', () => {
  const pdf = reportPdf(reportFixture());
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.equal(text.match(/\/Type \/Page /g)?.length, 2);
  assert.ok(text.includes('(classes | id: 7 | title: Intro, \\(safety\\) and more'), 'PDF strings escape parentheses');
  assert.ok(text.includes('rooms | id: 1 | name: Room A | capacity: not recorded'));
  assert.ok(text.includes('(notifications | membershipExpiration | eligible: 0 | on_time: 0'));
  assert.ok(text.includes('deliveryOnTimePercent: not measured) Tj'), 'missing rates read "not measured"');
  assert.equal(pdf.length, 7290);
  assert.equal(sha256(pdf), '195de1314f65fa4c70af2f33a050001b0e3d6a2ed0b3758fff7cad8acb4bbb68');
});

test('an evening class exports on its local day in the report time zone', () => {
  const data = reportFixture();
  // 00:30 UTC on Jan 18 is 7:30 pm on Jan 17 in New York.
  data.classes[0]!.startsAt = new Date(Date.UTC(2030, 0, 18, 0, 30));
  assert.ok(reportCsv(data).includes('"2030-01-17 19:30"'));
  assert.ok(reportPdf(data).toString('latin1').includes('2030-01-17 19:30 | room: Room A'));
  data.timeZone = 'America/Los_Angeles';
  assert.ok(reportCsv(data).includes('"2030-01-17 16:30"'));
});
