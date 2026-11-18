import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../src/db.js';
import { renderNotification } from '../src/notifications/templates.js';
import type { NotificationKind } from '../src/notifications/templates.js';
import { StudioService } from '../src/studios/service.js';
import type { StudioRentalRow } from '../src/studios/rows.js';

const context = {recipientEmail:'staff@example.com', recipientName:'Sam', senderName:'The Crafty Studio',
  senderEmail:'studio@example.com', postalAddress:'1449 Wiseburg Road, White Hall, Maryland 21161',
  preferencesUrl:'https://studio.example/profile'};

/** Answers the studio, staff and member lookups notices() makes and captures what it queues. */
function database(staff: number[]) {
  const queued: Array<{ userId: number; kind: NotificationKind; payload: Record<string, unknown> }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO app_notification_outbox'))
      queued.push({ userId: params[0] as number, kind: params[1] as NotificationKind, payload: JSON.parse(params[3] as string) });
    else if (sql.includes('FROM app_studio WHERE')) return { rows: [{ name: 'Paris' }] };
    else if (sql.includes('FROM user_role')) return { rows: staff.map(userid => ({ userid })) };
    else if (sql.includes('FROM "user" WHERE userid')) return { rows: [{ name: 'Priya Nair' }] };
    return { rows: [], rowCount: 0 };
  } } as unknown as Database;
  return { db, queued };
}

// As UPDATE ... RETURNING * gives it: no studio name.
const rental: StudioRentalRow = {
  id: 9, studio_id: 7, userid: 5, starts_on: '2030-01-31', ends_on: '2030-02-28', amount_cents: 35000,
  cancellation_policy: 'full_before_start', status: 'cancelled', payment_status: 'refund_pending', payment_method: 'manual',
  request_key: 'k', checkout_id: null, payment_intent: null, refund_id: null, payment_reference: 'cash 1',
  refund_reference: null, refund_cents: 35000, created_at: new Date(), hold_until: new Date(),
  reconcile_failures: 0, reconcile_after: null,
};
const service = new StudioService({} as never);

test('studio emails use the studio name, not its number', async () => {
  const { db, queued } = database([]);
  await service.notices(db, service.dates(rental), 'studio_reservation_confirmed');
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.payload.resourceName, 'Paris');
  const email = renderNotification('studio_reservation_confirmed', queued[0]!.payload, context);
  assert.ok(email.textContent.includes('You’re booked in Paris'), email.textContent);
  assert.ok(!email.textContent.includes('Studio 7'));
});

test('staff get a staff-worded copy that names the member, never the member notice', async () => {
  const { db, queued } = database([5, 70]);
  await service.notices(db, service.dates(rental), 'studio_reservation_confirmed');
  await service.notices(db, service.dates(rental), 'studio_reservation_cancelled');
  assert.deepEqual(queued.map(q => [q.userId, q.kind]), [
    [5, 'studio_reservation_confirmed'], [70, 'admin_studio_reservation_confirmed'],
    [5, 'studio_reservation_cancelled'], [70, 'admin_studio_reservation_cancelled'],
  ]);
  assert.equal(queued[0]!.payload.memberName, undefined, 'the member copy is unchanged');
  assert.equal(queued[1]!.payload.memberName, 'Priya Nair');

  const booked = renderNotification('admin_studio_reservation_confirmed', queued[1]!.payload, context);
  assert.equal(booked.subject.includes('Studio booking recorded'), true, booked.subject);
  assert.ok(booked.textContent.includes('Priya Nair booked Paris'), booked.textContent);
  assert.ok(booked.textContent.includes('This copy is for the staff record'));
  assert.ok(booked.textContent.includes('Open the studio desk: https://studio.example/admin/studios'));
  assert.ok(!/You’re booked|It’s all yours|View my rental/.test(booked.textContent));

  const cancelled = renderNotification('admin_studio_reservation_cancelled', queued[3]!.payload, context);
  assert.ok(cancelled.textContent.includes('Priya Nair cancelled their Paris booking'), cancelled.textContent);
  assert.ok(cancelled.textContent.includes('$350.00 is owed back to them. Record the refund on the studio desk'));
  assert.ok(cancelled.textContent.includes('Studio: Paris') && cancelled.textContent.includes('Refund: $350.00'));
  assert.ok(!/We’re returning|your original payment method/.test(cancelled.textContent));
});

test('staff cancellation copy states card refunds and no-refund outcomes plainly', () => {
  const base = { resourceName: 'Paris', memberName: 'Priya Nair', amount: '350.00', currency: 'USD' };
  const card = renderNotification('admin_studio_reservation_cancelled',
    { ...base, method: 'stripe_test', paymentStatus: 'refund_pending', refundAmount: '350.00' }, context);
  assert.ok(card.textContent.includes('$350.00 is being refunded to their card.'), card.textContent);
  const none = renderNotification('admin_studio_reservation_cancelled',
    { ...base, method: 'manual', paymentStatus: 'paid', refundAmount: '0.00' }, context);
  assert.ok(none.textContent.includes('No refund is due under the studio’s cancellation policy.'), none.textContent);
  const unpaid = renderNotification('admin_studio_reservation_cancelled',
    { ...base, method: 'manual', paymentStatus: 'unpaid', refundAmount: '0.00' }, context);
  assert.ok(unpaid.textContent.includes('They hadn’t paid, so no refund is due.'), unpaid.textContent);
});
