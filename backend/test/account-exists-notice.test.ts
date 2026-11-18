import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderNotification, securityKinds } from '../src/notifications/templates.js';

const context = { recipientEmail: 'member@example.com', recipientName: 'Sam', senderName: 'The Crafty Studio',
  senderEmail: 'studio@example.com', postalAddress: '1 Studio Way', preferencesUrl: 'https://studio.example/profile' };

// Sign-up answers every address alike; this notice is how an existing member learns of the attempt.
test('the existing-account notice points to sign-in and is always sent', () => {
  assert.ok(securityKinds.includes('account_exists'));
  const notice = renderNotification('account_exists', { resourceName: 'Laser cutter' }, context);
  assert.equal(notice.subject.includes('You already have an account'), true);
  assert.match(notice.textContent, /no new account was created/);
  assert.match(notice.textContent, /Go to login: https:\/\/studio\.example\/login/);
  assert.match(notice.textContent, /If it wasn’t you, you can ignore this email/);
  assert.match(notice.textContent, /regardless of your notification preferences/);
  assert.ok(!notice.textContent.includes('Laser cutter'));
});
