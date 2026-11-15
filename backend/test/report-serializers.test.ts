import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { reportCsv } from '../src/reports/csv.js';
import { reportPdf } from '../src/reports/pdf.js';
import { reportFixture } from './helpers/reportFixture.js';

// Date cells render through Date#toString, which follows the process time zone.
process.env.TZ = 'UTC';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Golden hashes were produced by the serializers as they were inlined in
// reports.ts before the export code moved to src/reports (commit 7c3d7a2).
test('CSV export is byte-identical to the original serializer', () => {
  const csv = reportCsv(reportFixture());
  const lines = csv.split('\r\n');
  assert.ok(lines[0]!.startsWith('"section","from","to","timeZone","generatedAt","note","period","category"'));
  assert.ok(csv.includes(`"'=SUM(A1:A9)","card"`), 'formula-looking cells are neutralized');
  assert.ok(csv.includes('"He said ""hi"" (twice) \\ back"'), 'quotes are doubled');
  assert.ok(csv.includes('"Wed Jan 02 2030 15:00:00 GMT+0000 (Coordinated Universal Time)"'));
  assert.equal(lines.length, 62, 'header, metadata, 3 notes, 52 section rows, 2 summaries, 3 cohorts');
  assert.equal(sha256(csv), '40fe721984708e63515ce3081a7e29e7969f9dea3b00772b143c90913d4ad44e');
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
  assert.equal(pdf.length, 7338);
  assert.equal(sha256(pdf), 'd418914ba78f476e333abbc5fb8db7f4357c4e45bb830ea0c1e07606e8b8add3');
});
