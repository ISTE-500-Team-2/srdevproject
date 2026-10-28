import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completedWaiverText, validateWaiverFields, waiverFormFields } from '../src/waiverForms.js';
import { waiverAcceptance } from './helpers/waiver.js';

const source = readFileSync(new URL('../../database/migrations/023_specialized_equipment_waiver.sql', import.meta.url), 'utf8').split('$equipment$')[1]!;

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
  assert.throws(() => validateWaiverFields(source, undefined, false), /Complete the waiver/);
  const fields = waiverFormFields(source);
  for (const [label, value] of [['Participant Signature', ''], ['Date of Birth', '2000-02-31'], ['Email', 'invalid'], ['Emergency Contact Phone', 'invalid']]) {
    const field = fields.find(f => f.label === label)!;
    assert.throws(() => validateWaiverFields(source, { ...body.formValues, [field.key]: value }, false));
  }
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, forged: 'value' }, false), /unrecognized/);
  const guardian = fields.find(f => f.section === 'guardian')!;
  assert.throws(() => validateWaiverFields(source, { ...body.formValues, [guardian.key]: '' }, true));
  assert.ok(validateWaiverFields(source, body.formValues, true));
  assert.equal(validateWaiverFields('Plain terms', undefined, undefined), null);
});

test('completed document replaces every blank while retaining wording and optional guardian state', () => {
  const body = waiverAcceptance({ description: source });
  const form = validateWaiverFields(source, body.formValues, false)!;
  const copy = completedWaiverText(source, form.values, false);
  assert.doesNotMatch(copy, /_{3,}/);
  assert.match(copy, /Participant Signature: Waiver Test Participant/);
  assert.match(copy, /Date of Birth: 2000-01-01/);
  assert.match(copy, /guardian consent not included/);
  assert.match(copy, /Method of Acceptance: ☑ Electronic/);
  assert.match(copy, /This section should be reviewed and approved by qualified legal counsel before use\./);
});
