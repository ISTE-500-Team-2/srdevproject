import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationKinds, renderNotification } from '../src/notifications/templates.js';

const context = {recipientEmail:'member@example.com', recipientName:'<script>alert(1)</script>',
  senderName:'The Crafty Studio', senderEmail:'studio@example.com',
  postalAddress:'1449 Wiseburg Road, White Hall, Maryland 21161', preferencesUrl:'https://studio.example/profile'};

test('every template includes sender/recipient, postal address and preference policy; dynamic HTML is escaped', () => {
  for (const kind of notificationKinds) {
    const result = renderNotification(kind, {resourceName:'<img src=x onerror=alert(1)>',
      waiverText:'Line one\n<script>bad</script>', signature:'Test Member', signedAt:'2030-01-01T00:00:00Z', waiverVersion:'v1',
      resetUrl:'https://studio.example/reset-password#'+'a'.repeat(43),
      confirmationUrl:'https://studio.example/confirm-email#'+'a'.repeat(43), password:'DO_NOT_RENDER', apiKey:'DO_NOT_RENDER'}, context);
    assert.ok(result.subject.length > 0);
    assert.ok(result.textContent.includes(context.postalAddress));
    assert.ok(result.textContent.includes(context.recipientEmail));
    assert.ok(result.textContent.includes(context.senderEmail));
    assert.ok(result.textContent.includes(kind === 'password_reset' || kind === 'password_changed'
      ? 'regardless of your notification preferences' : 'opt out of all'));
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

test('a signed form sends back the completed copy, not the blank document, in HTML and text', () => {
  const blank = 'Participant Name: __________\nEmergency Contact Phone: __________';
  const completed = 'Participant Name: Dana Whitfield\nEmergency Contact Phone: +1 (555) 010-1234';
  const result = renderNotification('waiver_signed', {waiverText:blank, completedWaiverText:completed,
    signature:'Dana Whitfield (electronic agreement)', signedAt:'2030-01-01T00:00:00Z', waiverVersion:'v2'}, context);
  for (const content of [result.textContent, result.htmlContent]) {
    assert.ok(content.includes('Emergency Contact Phone: +1 (555) 010-1234'));
    assert.ok(!content.includes('__________'));
  }
});

test('staff notices are written for staff and link to the staff workspace', () => {
  const result = renderNotification('admin_certification_revoked', {certificationName:'Laser', memberName:'Priya Nair',
    reason:'Unsafe operation'}, {...context, preferencesUrl:'https://studio.example/profile'});
  assert.ok(result.textContent.includes('Laser certification revoked'));
  assert.ok(result.textContent.includes('Priya Nair’s certification was revoked. This copy is for the staff record'));
  assert.ok(result.textContent.includes('Review certifications: https://studio.example/admin?tab=adminCertWaiver&section=certifications'));
  assert.ok(!/Here are the details/.test(result.textContent));
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
    'You weren’t charged for this rental, so there’s nothing to refund.'])
    assert.ok(result.textContent.includes(line), line);
  for (const raw of ['Currency:', 'Time zone:', 'unpaid', '2026-10-31', 'Refund 0 USD'])
    assert.ok(!result.textContent.includes(raw) && !result.htmlContent.includes(raw), raw);
  assert.ok(!result.textContent.includes('open for booking') && !result.htmlContent.includes('/studios'), 'no rebooking pitch after a cancellation');

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

test('reset security mail uses a fragment link and never offers to suppress security notices', () => {
  const resetUrl = 'https://studio.example/reset-password#' + 'a'.repeat(43);
  const result = renderNotification('password_reset', { resetUrl }, context);
  assert.ok(result.textContent.includes('Set a new password: ' + resetUrl));
  assert.ok(result.textContent.includes('30 minutes'));
  assert.ok(result.textContent.includes('If you didn’t ask for this, you can ignore this email.'));
  assert.ok(!result.htmlContent.includes('opt out of all'));
  assert.throws(() => renderNotification('password_reset', { resetUrl: 'https://studio.example/reset-password?token=bad' }, context), /Invalid reset link/);
  assert.throws(() => renderNotification('password_reset', { resetUrl: 'javascript:bad' }, context), /Invalid reset link/);
});

test('mail supports dark mode with class-based overrides and a plated logo, keeping mobile padding and security actions',()=>{
 const html=renderNotification('password_reset',{resetUrl:'https://studio.example/reset-password#'+'a'.repeat(43)},{...context,preferencesUrl:'https://studio.example/profile'}).htmlContent;
 assert.match(html,/color-scheme" content="light dark"/);
 assert.match(html,/@media\(prefers-color-scheme:dark\)\{\.em-bg\{/);
 assert.match(html,/\[data-ogsb\] \.em-card\{background-color/);
 assert.match(html,/\[data-ogsc\] \.em-ink\{color/);
 assert.doesNotMatch(html,/\[style\*=/,'no attribute-substring selectors');
 assert.match(html,/class="email-pad em-card em-line"/);
 assert.match(html,/<td bgcolor="#2b1306" class="em-btn"/);
 assert.match(html,/collaboratory-logo-email-plate\.png/);
 assert.match(html,/\.email-outer-pad\{padding:16px 8px!important\}/);
 assert.match(html,/Set a new password/);
});
test('turning off auto-renew sends an auto-renew confirmation',()=>{
 const r=renderNotification('membership_cancelled',{membershipName:'Monthly',endsAt:'2026-12-02T05:00:00Z'},context);
 assert.match(r.subject,/Auto-renew is off/);assert.match(r.textContent,/turned off automatic payments/);
});
test('sponsor requests name people by first name only and link to where the answer lives',()=>{
 // Even if a caller slipped an email into the payload, only the approved first-name fields render.
 const leaked={adultName:'Dana',minorName:'Emma',email:'dana.parent@example.com',adultEmail:'dana.parent@example.com'};
 const asked=renderNotification('sponsor_request_received',leaked,context);
 assert.match(asked.subject,/You have a sponsoring adult request/);
 assert.match(asked.textContent,/^Dana asked to be your sponsoring adult/);
 assert.match(asked.textContent,/accept or decline from your member home/);
 assert.ok(asked.textContent.includes('Review request: https://studio.example/\n'));
 const accepted=renderNotification('sponsor_request_accepted',leaked,context);
 assert.match(accepted.textContent,/^Emma accepted your sponsor request/);
 assert.ok(accepted.textContent.includes('View minors: https://studio.example/profile#minors'));
 const declined=renderNotification('sponsor_request_declined',leaked,context);
 assert.match(declined.textContent,/^Your sponsor request for Emma was declined/);
 assert.match(declined.subject,/Your sponsor request was declined/);
 for(const r of [asked,accepted,declined]){
  assert.ok(!r.textContent.includes('dana.parent')&&!r.htmlContent.includes('dana.parent'),'no adult email');
  assert.match(r.htmlContent,/class="email-pad em-card em-line"/);
  assert.match(r.textContent,/opt out of all notifications/);
 }
 assert.match(renderNotification('sponsor_request_received',{},context).textContent,/^You have a sponsoring adult request/);
});
