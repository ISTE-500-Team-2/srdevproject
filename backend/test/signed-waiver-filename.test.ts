import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signedWaiverFileName } from '../src/signedWaiverCopy.js';

const at = '2030-01-01T00:00:00Z';

test('signed waiver filenames combine the signer and waiver title with a text extension', () => {
  assert.equal(signedWaiverFileName('edwin chen (electronic agreement)', 'NameOfWaiver', at), 'SIGNED_Edwin_Chen_NameOfWaiver_2030-01-01.txt');
  assert.equal(signedWaiverFileName('Edwin Chen', 'Equipment Waiver', at), 'SIGNED_Edwin_Chen_Equipment_Waiver_2030-01-01.txt');
  assert.equal(signedWaiverFileName('Ana-Mar\u00eda Chen (electronic agreement)', 'Studio Access', at), 'SIGNED_Ana-Mar\u00eda_Chen_Studio_Access_2030-01-01.txt');
});

test('filenames remove path characters, control characters and extra extensions, with usable fallbacks', () => {
  const name = signedWaiverFileName('Edwin / Chen\r\n (electronic agreement)', '../../Waiver: "Laser"?*.pdf', at);
  assert.equal(name, 'SIGNED_Edwin_Chen_Waiver_Laser_pdf_2030-01-01.txt');
  assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/);
  assert.equal(signedWaiverFileName(' (electronic agreement)', '???', '../not a date'), 'SIGNED_Member_Signed_Waiver.txt');
});

test('long Unicode filenames stay bounded and preserve complete characters and the extension', () => {
  const name = signedWaiverFileName('\u674e'.repeat(200), '\u514d'.repeat(200), at);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 223);
  assert.ok(name.endsWith('.txt'));
  assert.ok(!name.includes('\ufffd'));
});

test('a renewal of the same waiver gets its own filename from its signing date', () => {
  assert.notEqual(signedWaiverFileName('Edwin Chen', 'Equipment Waiver', '2030-01-01T00:00:00Z'),
    signedWaiverFileName('Edwin Chen', 'Equipment Waiver', '2031-01-01T00:00:00Z'));
});
