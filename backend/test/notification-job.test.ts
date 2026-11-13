import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationJob, notificationKinds, renderNotification } from '../src/notifications/templates.js';

const context = { recipientEmail: 'member@example.invalid', senderName: 'Studio', senderEmail: 'studio@example.invalid', postalAddress: '1 Test Road' };

test('stored jobs with a known kind and text or number fields pass unchanged', () => {
  for (const kind of notificationKinds) assert.equal(notificationJob(kind, {}).kind, kind);
  const payload = { resourceName: 'Laser', reservationId: 12, reference: null, formValues: { a: 1 }, guardianConsent: true };
  const job = notificationJob('reservation_created', payload);
  assert.equal(job.payload, payload);
  assert.match(renderNotification(job.kind, job.payload, context).textContent, /Equipment: Laser/);
});

test('unknown kinds and malformed payloads are rejected before rendering', () => {
  assert.throws(() => notificationJob('reservation_creatd', {}), /Unsupported notification kind/);
  assert.throws(() => notificationJob('toString', {}), /Unsupported notification kind/);
  for (const payload of [null, 'text', 5, ['resourceName']])
    assert.throws(() => notificationJob('reservation_created', payload), /payload must be an object/);
  // These would otherwise render as blank details in a sent email.
  for (const value of [{ name: 'Laser' }, ['Laser'], true])
    assert.throws(() => notificationJob('reservation_created', { resourceName: value }), /resourceName must be text or a number/);
  // Fields that are never rendered may hold any JSON value.
  assert.doesNotThrow(() => notificationJob('waiver_expiring', { sourceType: 'waiver', sourceId: 3, readerId: { x: 1 } }));
});
