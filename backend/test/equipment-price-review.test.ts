import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewEquipmentPrice, type EquipmentPrice } from '../src/equipmentPricing.js';

const price: EquipmentPrice = { currency: 'USD', hours: 1, hourlyRateCents: 1200, equipmentCents: 1200,
  trainingFeeCents: 0, totalCents: 1200, certificationId: null, certificationRevision: null };

test('a move reviewed onto an unpriced machine confirms while the machine is still unpriced', () => {
  assert.doesNotThrow(() => reviewEquipmentPrice(null, null));
});

test('a reviewed price still has to match exactly', () => {
  assert.doesNotThrow(() => reviewEquipmentPrice(price, { ...price }));
  assert.doesNotThrow(() => reviewEquipmentPrice(price, undefined));
  // Reviewed as unpriced, but a rate was set before confirming (and the reverse).
  assert.throws(() => reviewEquipmentPrice(price, null), { code: 'PRICE_CHANGED' });
  assert.throws(() => reviewEquipmentPrice(null, price), { code: 'PRICE_CHANGED' });
  assert.throws(() => reviewEquipmentPrice(price, { ...price, totalCents: 1300 }), { code: 'PRICE_CHANGED' });
});
