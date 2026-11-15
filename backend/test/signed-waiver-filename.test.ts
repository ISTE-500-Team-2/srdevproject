import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signedWaiverFileName } from '../src/signedWaiverCopy.js';

test('signed waiver filenames combine the signer and waiver title with a text extension', () => {
  assert.equal(signedWaiverFileName('edwin chen (electronic agreement)', 'NameOfWaiver'), 'SIGNED_Edwin_Chen_NameOfWaiver.txt');
  assert.equal(signedWaiverFileName('Edwin Chen', 'Equipment Waiver'), 'SIGNED_Edwin_Chen_Equipment_Waiver.txt');
  assert.equal(signedWaiverFileName('Ana-Mar\u00eda Chen (electronic agreement)', 'Studio Access'), 'SIGNED_Ana-Mar\u00eda_Chen_Studio_Access.txt');
});

test('filenames remove path characters, control characters and extra extensions, with usable fallbacks', () => {
  const name = signedWaiverFileName('Edwin / Chen\r\n (electronic agreement)', '../../Waiver: "Laser"?*.pdf');
  assert.equal(name, 'SIGNED_Edwin_Chen_Waiver_Laser_pdf.txt');
  assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/);
  assert.equal(signedWaiverFileName(' (electronic agreement)', '???'), 'SIGNED_Member_Signed_Waiver.txt');
});

test('long Unicode filenames stay bounded and preserve complete characters and the extension', () => {
  const name = signedWaiverFileName('\u674e'.repeat(200), '\u514d'.repeat(200));
  assert.ok(Buffer.byteLength(name, 'utf8') <= 212);
  assert.ok(name.endsWith('.txt'));
  assert.ok(!name.includes('\ufffd'));
});
