import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAGE_SIZE, page } from '../src/pagination.js';
import { page as staffPage } from '../src/controllers/StaffController.js';

test('page keeps the first page-size rows and offers the next offset only when an extra row exists', () => {
  assert.equal(PAGE_SIZE, 50);
  const rows = Array.from({ length: 51 }, (_, i) => i);
  assert.deepEqual(page(rows, 100), { items: rows.slice(0, 50), nextOffset: 150 });
  assert.deepEqual(page(rows.slice(0, 50), 0), { items: rows.slice(0, 50), nextOffset: null });
  assert.deepEqual(page([], 0), { items: [], nextOffset: null });
});

test('StaffController still re-exports the shared page helper', () => {
  assert.equal(staffPage, page);
});
