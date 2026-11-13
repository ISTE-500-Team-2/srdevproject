import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditChanges } from '../src/auditChanges.js';

test('lists only the fields that changed, and the rest as unchanged', () => {
  const notice = { id: 8, summary: 'Dust collector down', resolution: null, resolvedAt: null };
  const result = auditChanges(notice, { ...notice, resolution: 'Filters fitted', resolvedAt: '2026-11-11T23:11:09.686Z' });
  assert.deepEqual(result?.changed, [
    { field: 'resolution', before: null, after: 'Filters fitted' },
    { field: 'resolvedAt', before: null, after: '2026-11-11T23:11:09.686Z' },
  ]);
  assert.deepEqual(result?.unchanged.map((f) => f.field), ['id', 'summary']);
});

test('a created record has changes but nothing unchanged; no states at all is null', () => {
  assert.deepEqual(auditChanges(null, { name: 'Bandsaw', note: null }), {
    changed: [{ field: 'name', before: null, after: 'Bandsaw' }],
    unchanged: [],
  });
  assert.equal(auditChanges(null, undefined), null);
});

test('never returns credentials or revision bookkeeping', () => {
  const result = auditChanges(
    { uid_hash: 'a', password: 'x', apiToken: 't', revision: 1, availability_revision: 3, label: 'Old' },
    { uid_hash: 'b', password: 'y', apiToken: 'u', revision: 2, availability_revision: 4, label: 'New' },
  );
  assert.deepEqual(result, { changed: [{ field: 'label', before: 'Old', after: 'New' }], unchanged: [] });
});

test('nested values compare by content, and bare values are named "value"', () => {
  assert.deepEqual(auditChanges({ roles: ['member'] }, { roles: ['member'] })?.changed, []);
  assert.deepEqual(auditChanges('open', 'closed')?.changed, [{ field: 'value', before: 'open', after: 'closed' }]);
});

test('secrets nested inside a field are dropped too', () => {
  const result = auditChanges(
    { address: { city: 'Towson', password: 'a', extra: [{ apiToken: 'x', note: 'keep' }] } },
    { address: { city: 'Bel Air', password: 'b', extra: [{ apiToken: 'y', note: 'keep' }] } },
  );
  assert.deepEqual(result?.changed, [
    { field: 'address', before: { city: 'Towson', extra: [{ note: 'keep' }] }, after: { city: 'Bel Air', extra: [{ note: 'keep' }] } },
  ]);
  assert.ok(!JSON.stringify(result).match(/password|apiToken/));
});
