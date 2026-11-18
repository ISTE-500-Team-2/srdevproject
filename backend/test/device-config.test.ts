import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceConfig } from '../src/deviceAccess.js';

const key = 'k'.repeat(32), secret = 's'.repeat(32);

test('readers stay off until the card key or a reader list is set', () => {
  assert.equal(readDeviceConfig({}), undefined);
  // The sponsor template's blank lines, as Docker Compose passes them.
  assert.equal(readDeviceConfig({ ACCESS_CARD_HASH_KEY: '', ACCESS_READERS_JSON: '', ACCESS_SETUP_GATEWAYS_JSON: '' }), undefined);
});

test('a blank reader or gateway list with a card key starts with no readers instead of crashing', () => {
  for (const blank of ['', '   ', '\n'])
    assert.deepEqual(readDeviceConfig({ ACCESS_CARD_HASH_KEY: key, ACCESS_READERS_JSON: blank, ACCESS_SETUP_GATEWAYS_JSON: blank }),
      { readers: [], cardHashKey: key, setupGateways: [] });
});

test('configured readers and gateways are still read', () => {
  const readers = [{ id: 'front', secret, kind: 'building' }];
  const setupGateways = [{ id: 'pi', name: 'Workshop Pi', secret }];
  assert.deepEqual(readDeviceConfig({ ACCESS_CARD_HASH_KEY: key, ACCESS_READERS_JSON: JSON.stringify(readers),
    ACCESS_SETUP_GATEWAYS_JSON: JSON.stringify(setupGateways) }), { readers, cardHashKey: key, setupGateways });
});

test('a bad setting fails startup with an error that names it and never echoes its value', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ACCESS_CARD_HASH_KEY: key, ACCESS_READERS_JSON: `{"id":"front","secret":"${secret}"` }, /^ACCESS_READERS_JSON must be a JSON array/],
    [{ ACCESS_CARD_HASH_KEY: key, ACCESS_READERS_JSON: '{}' }, /^ACCESS_READERS_JSON must be a JSON array/],
    [{ ACCESS_CARD_HASH_KEY: key, ACCESS_SETUP_GATEWAYS_JSON: `[{"id":"pi","secret":"${secret}"` }, /^ACCESS_SETUP_GATEWAYS_JSON must be a JSON array/],
    [{ ACCESS_CARD_HASH_KEY: key, ACCESS_SETUP_GATEWAYS_JSON: '[{"id":"pi"}]' }, /ACCESS_SETUP_GATEWAYS_JSON/],
    [{ ACCESS_CARD_HASH_KEY: key, ACCESS_READERS_JSON: '[{"id":"front"}]' }, /ACCESS_READERS_JSON/],
    [{ ACCESS_READERS_JSON: '[]' }, /^ACCESS_CARD_HASH_KEY must contain at least 32 characters/],
    [{ ACCESS_CARD_HASH_KEY: 'short' }, /^ACCESS_CARD_HASH_KEY/],
  ];
  for (const [env, message] of cases)
    assert.throws(() => readDeviceConfig(env), (error: Error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(secret), 'the error must not echo a secret');
      return true;
    }, JSON.stringify(env));
});
