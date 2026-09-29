import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNotificationConfig } from '../src/notifications/config.js';

test('real sending is opt-in and cannot run with demo login', () => {
  assert.equal(readNotificationConfig({}), undefined);
  assert.throws(() => readNotificationConfig({ EMAIL_ENABLED: 'true', ENABLE_DEMO_LOGIN: 'true' }), /demo login/);
  assert.throws(() => readNotificationConfig({ EMAIL_ENABLED: 'true' }), /BREVO_API_KEY/);
  assert.throws(() => readNotificationConfig({ EMAIL_ENABLED: 'true', BREVO_API_KEY: 'test-only', APP_ORIGIN: 'http://example.test', NODE_ENV: 'production' }), /HTTPS/);
  const result = readNotificationConfig({ EMAIL_ENABLED: 'true', BREVO_API_KEY: 'test-only', APP_ORIGIN: 'https://example.test' });
  assert.equal(result?.replyToEmail, 'arborcollaboratory@yahoo.com');
  assert.equal(result?.postalAddress, '1449 Wiseburg Road, White Hall, Maryland 21161');
});
