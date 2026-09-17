import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_NOTIFICATION_KEYS,
  notificationTemplates,
  renderNotificationTemplate,
} from '../src/notifications.js';
import type { NotificationKey } from '../src/notifications.js';

const required: NotificationKey[] = [
  'accountCreation',
  'waiverSigned',
  'reservationConfirmed',
  'reservationCancelled',
  'paymentReceipt',
  'systemIssue',
  'refundIssued',
];

test('all required notification templates are present and branded', () => {
  for (const key of required) {
    assert.ok(notificationTemplates[key], `missing ${key}`);
    assert.match(notificationTemplates[key].subject, /The Crafty Studio/i);
    assert.match(notificationTemplates[key].body, /The Crafty Studio/i);
  }

  assert.deepEqual(ALL_NOTIFICATION_KEYS, [...required]);
});

test('template variables interpolate and include waiver copy details', () => {
  const account = renderNotificationTemplate('accountCreation', {
    firstName: 'Avery',
    email: 'avery@example.com',
  });
  assert.match(account.subject, /Avery/);
  assert.match(account.body, /avery@example.com/);

  const waiver = renderNotificationTemplate('waiverSigned', {
    firstName: 'Jordan',
    waiverName: 'Release and Waiver',
    signatureDate: '2026-09-16',
  });
  assert.match(waiver.body, /Jordan/);
  assert.match(waiver.body, /Release and Waiver/i);
  assert.match(waiver.body, /signed waiver/i);
  assert.match(waiver.body, /2026-09-16/);

  const reservation = renderNotificationTemplate('reservationConfirmed', {
    firstName: 'Morgan',
    reservationId: 'RS-104',
    equipmentName: '3D Printer',
  });
  assert.match(reservation.body, /RS-104/);
  assert.match(reservation.body, /3D Printer/);
});
