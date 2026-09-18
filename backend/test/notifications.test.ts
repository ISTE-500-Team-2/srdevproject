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
  'accountCreationFailed',
  'waiverSigned',
  'reservationConfirmed',
  'reservationCancelled',
  'studioCancellation',
  'paymentReceipt',
  'transactionFailed',
  'systemIssue',
  'refundIssued',
  'dayPassIssued',
  'membershipIssued',
];

test('all required notification templates are present and branded', () => {
  for (const key of required) {
    assert.ok(notificationTemplates[key], `missing ${key}`);
    assert.match(notificationTemplates[key].subject, /The Crafty Studio/i);
    assert.match(notificationTemplates[key].body, /The Crafty Studio/i);
    assert.match(
      notificationTemplates[key].body,
      /1449 Wiseburg Road, White Hall, Maryland 21161/i,
    );
    assert.match(
      notificationTemplates[key].body,
      /arborcollaboratory@yahoo\.com/i,
    );
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
  assert.match(waiver.body, /Certifications & waivers account records/i);
  assert.doesNotMatch(waiver.body, /attached/i);

  const reservation = renderNotificationTemplate('reservationConfirmed', {
    firstName: 'Morgan',
    reservationId: 'RS-104',
    equipmentName: '3D Printer',
  });
  assert.match(reservation.body, /RS-104/);
  assert.match(reservation.body, /3D Printer/);

  const cancelled = renderNotificationTemplate('reservationCancelled', {
    firstName: 'Sam',
    reservationId: 'RS-204',
    resourceName: 'Private Studio A',
  });
  assert.match(cancelled.body, /Private Studio A/);
  assert.doesNotMatch(cancelled.body, /Equipment:/);

  const studio = renderNotificationTemplate('studioCancellation', {
    firstName: 'Riley',
    studioName: 'Studio Bay 2',
    reservationId: 'ST-7',
    cancelledDate: '2026-09-18',
    reason: 'Maintenance',
  });
  assert.match(studio.body, /Studio Bay 2/);
  assert.match(studio.body, /Maintenance/);

  const failed = renderNotificationTemplate('transactionFailed', {
    firstName: 'Casey',
    transactionId: 'TX-9',
    amount: '15.00',
    reason: 'Card declined',
  });
  assert.match(failed.body, /TX-9/);
  assert.match(failed.body, /Card declined/);

  const dayPass = renderNotificationTemplate('dayPassIssued', {
    firstName: 'Drew',
    dayPassId: 'DP-3',
    validDate: '2026-09-20',
    amount: '15.00',
  });
  assert.match(dayPass.body, /DP-3/);
  assert.match(dayPass.body, /2026-09-20/);

  const membership = renderNotificationTemplate('membershipIssued', {
    firstName: 'Jamie',
    membershipId: 'MB-6',
    planName: 'Monthly',
    startDate: '2026-09-18',
    endDate: '2026-10-18',
    amount: '35.00',
  });
  assert.match(membership.body, /MB-6/);
  assert.match(membership.body, /Monthly/);
});
