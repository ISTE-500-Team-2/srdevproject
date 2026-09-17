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
    assert.ok(!result.htmlContent.includes('<img'));
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
  assert.ok(result.textContent.includes('January 1, 2030'));
  assert.ok(result.textContent.includes('5:00:00 PM PST'));
  assert.ok(result.textContent.includes('Starts: 2030-01-01'));
  assert.ok(!result.textContent.includes('2030-01-02T01:00:00Z'));
});
