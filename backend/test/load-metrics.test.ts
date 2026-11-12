import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concurrent, stableLatency, stageResult, summarize } from './load/metrics.js';

test('load acceptance fails on false grants, fast incorrect denials, timeout responses and latency violations', () => {
  const result = stageResult('burst', 100, 2000, [
    { workload: 'access', elapsedMs: 30, ok: false, falseGrant: true },
    { workload: 'access', elapsedMs: 40, ok: false, timeout: true },
    { workload: 'access', elapsedMs: 2000, ok: true },
    { workload: 'waivers', elapsedMs: 6000, ok: true },
    { workload: 'training', elapsedMs: 5999, ok: true },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.errors, 2);
  assert.equal(result.falseGrants, 1);
  assert.equal(result.timeouts, 1);
  assert.equal(result.sloViolations, 2);
  assert.equal(result.workloads.training?.sloViolations, 0);
  assert.equal(stageResult('empty', 25, 1, []).passed, false);
  assert.equal(summarize([]).p95Ms, null);
});

test('load percentiles use nearest rank and recovery compares equal-load latency with a noise allowance', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ workload: 'access' as const, elapsedMs: i + 1, ok: true }));
  assert.equal(summarize(samples).p95Ms, 95);
  assert.equal(summarize(samples).p99Ms, 99);
  assert.equal(stableLatency(20, 100), true);
  assert.equal(stableLatency(200, 401), false);
  assert.equal(stableLatency(null, 10), false);
});

test('load workers respect concurrency and join in-flight work before propagating a failure', async () => {
  let active = 0, maximum = 0, completed = 0;
  await assert.rejects(concurrent(20, 3, async i => {
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (i === 1) throw Error('fixture failure');
      completed++;
    } finally { active--; }
  }), /fixture failure/);
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.equal(completed, 19);
});
