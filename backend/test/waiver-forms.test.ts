import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedWaiverText, serverWaiverValues, validateWaiverFields, waiverFormFields } from '../src/waiverForms.js';
import { specializedEquipmentWaiver } from '../src/specializedEquipmentWaiver.js';
import { waiverAcceptance } from './helpers/waiver.js';

const source = specializedEquipmentWaiver.text;
const signer = 'Waiver Test Participant';

test('every document blank becomes a separate field, including repeated and administrative slots', () => {
  const fields = waiverFormFields(source);
  assert.equal(fields.length, 19);
  assert.equal(fields.length, [...source.matchAll(/_{3,}/g)].length);
  assert.equal(new Set(fields.map(f => f.key)).size, fields.length);
  assert.equal(fields.filter(f => f.label === 'Participant Name').length, 2);
  assert.equal(fields.filter(f => f.label === 'Date').length, 3);
  assert.equal(fields.filter(f => f.section === 'guardian').length, 6);
  assert.equal(fields.filter(f => f.section === 'administrative').length, 4);
  assert.deepEqual(waiverFormFields('Name: ____ Date: ____').map(f => f.label), ['Name', 'Date']);
  assert.deepEqual(waiverFormFields('No blanks in these terms.'), []);
});

test('validation requires entries, valid dates and contact details, and complete selected guardian consent', () => {
  const body = waiverAcceptance({ description: source });
  assert.throws(() => validateWaiverFields(source, undefined, false, signer), /Complete the waiver/);
  const fields = waiverFormFields(source);
  for (const [label, value] of [['Participant Signature', ''], ['Date of Birth', '2000-02-31'], ['Email', 'invalid'], ['Emergency Contact Phone', 'invalid']]) {
    const field = fields.find(f => f.label === label)!;
    assert.throws(() => validateWaiverFields(source, { ...body.formValues, [field.key]: value }, false, signer));
  }
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, forged: 'value' }, false, signer), /unrecognized/);
  const guardian = fields.find(f => f.section === 'guardian' && f.source === 'member')!;
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, [guardian.key]: '' }, true, signer));
  assert.ok(validateWaiverFields(source, body.formValues, true, signer));
  assert.equal(validateWaiverFields('Plain terms', undefined, undefined, signer), null);
});

test('completed document replaces every blank while retaining wording and optional guardian state', () => {
  const body = waiverAcceptance({ description: source });
  const form = validateWaiverFields(source, body.formValues, false, signer)!;
  const server = serverWaiverValues(source, { memberId: 42, signerName: signer, waiverVersion: '2026-10-27', signedAt: new Date('2026-10-28T18:05:00Z'), timeZone: 'America/New_York' });
  const copy = completedWaiverText(source, { ...form.values, ...server }, false);
  assert.doesNotMatch(copy, /_{3,}/);
  assert.match(copy, /Participant Signature: Waiver Test Participant/);
  assert.match(copy, /Date of Birth: 2000-01-01/);
  assert.match(copy, /guardian consent not included/);
  assert.match(copy, /Method of Acceptance: ☑ Electronic/);
  assert.match(copy, /This section should be reviewed and approved by qualified legal counsel before use\./);
});

test('identity, version, signing time and the administrative record come from the server', () => {
  const fields = waiverFormFields(source);
  const serverLabels = fields.filter(f => f.source === 'server').map(f => f.label);
  assert.ok(serverLabels.includes('Waiver Version'));
  assert.ok(serverLabels.includes('Accepted Date/Time'));
  assert.ok(serverLabels.includes('User/Member ID'));
  assert.ok(serverLabels.includes('Participant Name'));
  assert.equal(serverLabels.filter(l => l === 'Date').length, 3);
  const body = waiverAcceptance({ description: source });
  // A member can't supply any of them.
  for (const field of fields.filter(f => f.source === 'server'))
    assert.throws(() => validateWaiverFields(source, { ...body.formValues, [field.key]: 'forged' }, false, signer), /unrecognized/);
  const server = serverWaiverValues(source, { memberId: 42, signerName: signer, waiverVersion: '2026-10-27', signedAt: new Date('2026-10-28T18:05:00Z'), timeZone: 'America/New_York' });
  const copy = completedWaiverText(source, { ...validateWaiverFields(source, body.formValues, false, signer)!.values, ...server }, false);
  assert.match(copy, /User\/Member ID: 42/);
  assert.match(copy, /Waiver Version: 2026-10-27/);
  assert.match(copy, /Accepted Date\/Time: 2026-10-28 14:05 \(America\/New_York\)/);
  assert.match(copy, /Participant Name: Waiver Test Participant/);
  assert.match(copy, /Staff Witness, if applicable: Not applicable \(electronic acceptance\)/);
});

test('the signature has to match the account holder, and a guardian signature the guardian name', () => {
  const fields = waiverFormFields(source);
  const body = waiverAcceptance({ description: source });
  const signature = fields.find(f => f.section === 'participant' && /signature/i.test(f.label))!;
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, [signature.key]: 'Someone Else' }, false, signer), /Type your full name/);
  assert.ok(validateWaiverFields(source, { ...body.formValues, [signature.key]: '  waiver   TEST participant ' }, false, signer));
  const guardianSignature = fields.find(f => f.section === 'guardian' && /signature/i.test(f.label))!;
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, [guardianSignature.key]: 'Not The Guardian' }, true, signer), /guardian signature/);
});
