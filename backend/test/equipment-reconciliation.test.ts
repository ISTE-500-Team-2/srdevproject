import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { startEquipmentReconciliation } from '../src/equipmentReconciliation.js';

test('reconciliation runs at start and on its interval, never overlapping, and stop waits for the running pass', async () => {
  let release!: () => void;
  const billing = { reconcile: mock.fn(() => new Promise<void>(resolve => { release = resolve; })) };
  const runtime = startEquipmentReconciliation(billing, 5);
  assert.equal(billing.reconcile.mock.callCount(), 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(billing.reconcile.mock.callCount(), 1, 'a running pass is not overlapped');
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(billing.reconcile.mock.callCount() >= 2, 'the next interval runs again');
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false, 'stop waits for the pass in progress');
  const count = billing.reconcile.mock.callCount();
  release();
  await stopping;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(billing.reconcile.mock.callCount(), count, 'no pass starts after stop');
});

test('a failed pass is logged by class only and retried on the next interval', async () => {
  const error = mock.method(console, 'error', () => {});
  let attempts = 0;
  const runtime = startEquipmentReconciliation({ reconcile: async () => { attempts++; throw new TypeError('secret provider body'); } }, 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(attempts >= 2);
    const [message, detail] = error.mock.calls[0]!.arguments;
    assert.match(String(message), /Equipment payment reconciliation failed/);
    assert.equal((detail as { error: string }).error, 'TypeError');
    assert.doesNotMatch(JSON.stringify(error.mock.calls.map(c => c.arguments)), /secret provider body/);
  } finally {
    await runtime.stop();
    error.mock.restore();
  }
});
