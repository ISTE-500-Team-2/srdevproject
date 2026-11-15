import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverWaiverValues, validateWaiverFields, waiverFormFields, waiverFormLines } from '../src/waiverForms.js';
import { specializedEquipmentWaiver } from '../src/specializedEquipmentWaiver.js';
import { waiverAcceptance } from './helpers/waiver.js';

const source = specializedEquipmentWaiver.text;

test('every blank in the equipment waiver carries an explicit semantic id', () => {
  assert.deepEqual(waiverFormFields(source).map(f => [f.section, f.label, f.semantic]), [
    ['participant', 'Participant Name', 'participant-name'],
    ['participant', 'Date of Birth', 'date-of-birth'],
    ['participant', 'Email', 'other'],
    ['participant', 'Emergency Contact Name', 'emergency-contact-name'],
    ['participant', 'Emergency Contact Phone', 'emergency-contact-phone'],
    ['participant', 'Date', 'signing-date'],
    ['participant', 'Participant Name', 'participant-name'],
    ['participant', 'Participant Signature', 'signature'],
    ['participant', 'Date', 'signing-date'],
    ['guardian', 'Parent/Guardian Name', 'guardian-name'],
    ['guardian', 'Relationship to Participant', 'relationship'],
    ['guardian', 'Parent/Guardian Signature', 'signature'],
    ['guardian', 'Date', 'signing-date'],
    ['guardian', 'Phone', 'other'],
    ['guardian', 'Email', 'other'],
    ['administrative', 'Waiver Version', 'waiver-version'],
    ['administrative', 'Accepted Date/Time', 'accepted-at'],
    ['administrative', 'User/Member ID', 'member-id'],
    ['administrative', 'Staff Witness, if applicable', 'staff-witness'],
  ]);
});

test('administrative meanings apply only inside the administrative record', () => {
  const [member, admin] = waiverFormFields('Member ID: ____\nAdministrative Record\nMember ID: ____');
  assert.equal(member!.semantic, 'other');
  assert.equal(member!.source, 'member');
  assert.equal(admin!.semantic, 'member-id');
  assert.equal(admin!.source, 'server');
});

test('server values and signature validation follow the semantic ids', () => {
  const values = serverWaiverValues(source, { memberId: 42, signerName: 'Pat Doe', waiverVersion: '2.0',
    signedAt: new Date('2026-03-04T15:06:00Z'), timeZone: 'America/New_York' });
  const byLabel = Object.fromEntries(waiverFormFields(source).filter(f => f.source === 'server').map(f => [`${f.section}:${f.label}`, values[f.key]]));
  assert.equal(byLabel['administrative:Waiver Version'], '2.0');
  assert.equal(byLabel['administrative:Accepted Date/Time'], '2026-03-04 10:06 (America/New_York)');
  assert.equal(byLabel['administrative:User/Member ID'], '42');
  assert.equal(byLabel['administrative:Staff Witness, if applicable'], 'Not applicable (electronic acceptance)');
  assert.equal(byLabel['participant:Participant Name'], 'Pat Doe');
  assert.equal(byLabel['participant:Date'], '2026-03-04');
  const body = waiverAcceptance({ description: source, signerName: 'Pat Doe' });
  const signature = waiverFormFields(source).find(f => f.section === 'participant' && f.semantic === 'signature')!;
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, [signature.key]: 'Someone Else' }, false, 'Pat Doe'), { code: 'SIGNATURE_MISMATCH' });
  assert.ok(validateWaiverFields(source, body.formValues, false, 'Pat Doe'));
});

test('each description line has a layout kind', () => {
  const lines = source.split(/\r?\n/);
  const kinds = waiverFormLines(source);
  assert.equal(kinds.length, lines.length);
  assert.equal(kinds[lines.findIndex(l => l.startsWith('Method of Acceptance:'))], 'acceptance-method');
  assert.equal(kinds[lines.indexOf('Parent or Legal Guardian Consent')], 'heading');
  assert.equal(kinds[lines.indexOf('Administrative Record')], 'heading');
  assert.deepEqual(waiverFormLines('1. Scope\r\nPlain terms.\n\nMethod of Acceptance: ☐ Electronic'), ['heading', 'text', 'text', 'acceptance-method']);
  // Same rules as the form always used: case-sensitive, exact section titles.
  assert.deepEqual(waiverFormLines('administrative record\nAdministrative Record '), ['text', 'text']);
});
