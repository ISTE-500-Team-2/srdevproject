import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationKinds, renderNotification } from '../src/notifications/templates.js';

const context = {recipientEmail:'member@example.com', recipientName:'<script>alert(1)</script>',
  senderName:'The Crafty Studio', senderEmail:'studio@example.com',
  postalAddress:'1449 Wiseburg Road, White Hall, Maryland 21161', preferencesUrl:'https://studio.example/profile'};

test('every template includes sender/recipient, postal address and opt-out; dynamic HTML is escaped', () => {
  for (const kind of notificationKinds) {
    const result = renderNotification(kind, {resourceName:'<img src=x onerror=alert(1)>',
      waiverText:'Line one\n<script>bad</script>', signature:'Test Member', signedAt:'2030-01-01T00:00:00Z', waiverVersion:'v1',
      confirmationUrl:'https://studio.example/confirm-email#'+'a'.repeat(43), password:'DO_NOT_RENDER', apiKey:'DO_NOT_RENDER'}, context);
    assert.ok(result.subject.length > 0);
    assert.ok(result.textContent.includes(context.postalAddress));
    assert.ok(result.textContent.includes(context.recipientEmail));
    assert.ok(result.textContent.includes(context.senderEmail));
    assert.ok(result.textContent.includes('opt out of all'));
    assert.ok(!result.htmlContent.includes('<script>'));
    assert.ok(!result.htmlContent.includes('<img src=x'));
    assert.ok(!result.textContent.includes('DO_NOT_RENDER'));
  }
});

test('signed copy uses complete snapshot and rejects absent signature/text instead of claiming a copy', () => {
  assert.throws(() => renderNotification('waiver_signed', {}, context), /requires/);
  const result = renderNotification('waiver_signed', {waiverText:'Full original terms\nSecond paragraph',
    signature:'Jane & Doe', signedAt:'2030-01-01T00:00:00Z', waiverVersion:'v7'},context);
  assert.ok(result.textContent.includes('Full original terms\nSecond paragraph'));
  assert.ok(result.textContent.includes('Jane & Doe'));
  assert.ok(result.htmlContent.includes('Jane &amp; Doe'));
  assert.throws(() => renderNotification('account_created', {}, {...context,preferencesUrl:'javascript:alert(1)'}), /Invalid/);
});

test('scheduler membership payload renders plan and expiry in user timezone without shifting calendar dates', () => {
  const result = renderNotification('membership_expiring', {sourceType:'membership',name:'Monthly Studio',
    expiresAt:'2030-01-02T01:00:00Z', startsAt:'2030-01-01',timeZone:'America/Los_Angeles'},context);
  assert.ok(result.textContent.includes('Membership: Monthly Studio'));
  assert.ok(result.textContent.includes('Expires: Tue, Jan 1, 2030 at 5:00 PM PST'));
  assert.ok(result.textContent.includes('Starts: Tue, Jan 1, 2030'));
  assert.ok(!result.textContent.includes('2030-01-02T01:00:00Z'));
});

test('studio cancellation reads as a receipt, not a field dump', () => {
  const payload = {reservationId:4, resourceName:'Studio 1', startsAt:'2026-10-31', endsAt:'2026-11-30', amount:'350.00',
    currency:'USD', method:'manual', paymentStatus:'unpaid', refundAmount:'0.00', timeZone:'America/New_York'};
  const result = renderNotification('studio_reservation_cancelled', payload, {...context, recipientName:'Brian'});
  for (const line of ['Your Studio 1 booking is cancelled', 'Studio: Studio 1', 'Dates: Sat, Oct 31 – Mon, Nov 30, 2026',
    'Booking: #4', 'Rental total: $350.00', 'Refund: $0.00', 'Payment method: In person at the studio',
    'No payment was collected, so there’s nothing to refund.', 'Book new dates: https://studio.example/studios'])
    assert.ok(result.textContent.includes(line), line);
  for (const raw of ['Currency:', 'Time zone:', 'unpaid', '2026-10-31', 'Refund 0 USD'])
    assert.ok(!result.textContent.includes(raw) && !result.htmlContent.includes(raw), raw);
  assert.ok(result.htmlContent.includes('href="https://studio.example/studios"'));

  const paid = renderNotification('studio_reservation_cancelled', {...payload, paymentStatus:'refund_pending', refundAmount:'350.00'}, context);
  assert.ok(paid.textContent.includes('We’re returning $350.00 to your original payment method.'));
  const late = renderNotification('studio_reservation_cancelled', {...payload, paymentStatus:'paid'}, context);
  assert.ok(late.textContent.includes('isn’t eligible for a refund'));
});

test('same-day equipment bookings collapse to one readable time range', () => {
  const result = renderNotification('reservation_created', {resourceName:'Laser Engraver',
    startsAt:'2030-01-15T22:00:00Z', endsAt:'2030-01-16T00:00:00Z', timeZone:'America/New_York'}, context);
  assert.ok(result.textContent.includes('When: Tue, Jan 15, 2030, 5:00 PM – 7:00 PM EST'));
  assert.ok(result.textContent.includes('Your Laser Engraver session is booked'));
});
