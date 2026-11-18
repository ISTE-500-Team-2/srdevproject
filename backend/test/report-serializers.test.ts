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
// then updated when dates began rendering as local "YYYY-MM-DD HH:mm", and again when
// expiringMembers became endedWithoutRenewingMembers beside a live membersEndingWithin30Days.
test('CSV export is byte-identical to the original serializer', () => {
  const csv = reportCsv(reportFixture());
  const lines = csv.split('\r\n');
  assert.ok(lines[0]!.startsWith('"section","from","to","timeZone","generatedAt","note","period","category"'));
  assert.ok(csv.includes(`"'=SUM(A1:A9)","card"`), 'formula-looking cells are neutralized');
  assert.ok(csv.includes('"He said ""hi"" (twice) \\ back"'), 'quotes are doubled');
  assert.ok(csv.includes('"2030-01-02 10:00"'), 'class start in New York time, not Date#toString');
  assert.ok(lines[0]!.includes('"endedWithoutRenewingMembers"') && lines[0]!.includes('"membersEndingWithin30Days"'));
  assert.ok(!csv.includes('expiringMembers'), 'lapsed memberships are not labelled as expiring');
  assert.equal(lines.length, 62, 'header, metadata, 3 notes, 52 section rows, 2 summaries, 3 cohorts');
  assert.equal(sha256(csv), 'b499af737117fa16fc88c9d3f5bd9a1ac33b35fde6b1a080b4911a6506ded924');
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
  assert.equal(pdf.length, 7354);
  assert.equal(sha256(pdf), '16a98de7faeb6d1914501ffc9e9d5aa76262b13228fa0bc63a2c1f132773ed05');
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
