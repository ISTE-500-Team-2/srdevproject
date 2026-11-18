import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../src/db.js';
import { renderNotification } from '../src/notifications/templates.js';
import type { NotificationKind } from '../src/notifications/templates.js';
import { StudioService } from '../src/studios/service.js';
import { lastRentalDay } from '../src/studios/domain.js';
import type { StudioRentalRow } from '../src/studios/rows.js';

const context = {recipientEmail:'member@example.com', recipientName:'Member', senderName:'The Crafty Studio',
  senderEmail:'studio@example.com', postalAddress:'1449 Wiseburg Road, White Hall, Maryland 21161'};

// Captures the queued notifications instead of writing to PostgreSQL.
function outbox() {
  const queued: Array<{ kind: NotificationKind; payload: Record<string, unknown> }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO app_notification_outbox'))
      queued.push({ kind: params[1] as NotificationKind, payload: JSON.parse(params[3] as string) });
    return { rows: [], rowCount: 0 };
  } } as unknown as Database;
  return { db, queued };
}

// A one-month rental from Jan 31 is stored with the exclusive end Feb 28 (the first free day).
const rental: StudioRentalRow = {
  id: 9, studio_id: 1, userid: 5, starts_on: '2030-01-31', ends_on: '2030-02-28', amount_cents: 20000,
  cancellation_policy: 'full_before_start', status: 'confirmed', payment_status: 'paid', payment_method: 'manual',
  request_key: 'k', checkout_id: null, payment_intent: null, refund_id: null, payment_reference: 'cash 1',
  refund_reference: null, refund_cents: 20000, created_at: new Date(), hold_until: new Date(),
  reconcile_failures: 0, reconcile_after: null,
};
const service = new StudioService({} as never);

test('studio confirmation and cancellation emails name the last occupied day, not the exclusive end', async () => {
  for (const kind of ['studio_reservation_confirmed', 'studio_reservation_cancelled'] as const) {
    const { db, queued } = outbox();
    await service.notices(db, { ...service.dates(rental), name: 'Studio 1' }, kind);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.payload.startsAt, '2030-01-31');
    assert.equal(queued[0]!.payload.endsAt, '2030-02-27');
    const email = renderNotification(kind, { ...queued[0]!.payload, timeZone: 'America/New_York' }, context);
    assert.ok(email.textContent.includes('Dates: Thu, Jan 31 – Wed, Feb 27, 2030'), email.textContent);
    assert.ok(!email.textContent.includes('Feb 28'), 'Feb 28 is bookable by someone else');
  }
});

test('studio payment receipt names the last occupied day', async () => {
  const { db, queued } = outbox();
  await service.receipt(db, rental, 'cash 1');
  assert.equal(queued[0]!.kind, 'payment_receipt');
  assert.equal(queued[0]!.payload.endsAt, '2030-02-27');
  const email = renderNotification('payment_receipt', queued[0]!.payload, context);
  assert.ok(email.textContent.includes('Thu, Jan 31 – Wed, Feb 27, 2030'), email.textContent);
});

test('the last day crosses month and leap-year boundaries in UTC', async () => {
  const { db, queued } = outbox();
  await service.receipt(db, { ...rental, starts_on: '2032-02-01', ends_on: '2032-03-01' }, 'r');
  assert.equal(queued[0]!.payload.endsAt, '2032-02-29');
});

test("the last rental day is the day before the exclusive end, across months and leap years", () => {
  assert.equal(lastRentalDay("2030-02-28"), "2030-02-27");
  assert.equal(lastRentalDay("2030-03-01"), "2030-02-28");
  assert.equal(lastRentalDay("2028-03-01"), "2028-02-29");
  assert.equal(lastRentalDay("2031-01-01"), "2030-12-31");
});
