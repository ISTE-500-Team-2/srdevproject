export type Workload = 'access' | 'waivers' | 'training' | 'health';
export interface Sample {
  workload: Workload;
  elapsedMs: number;
  ok: boolean;
  falseGrant?: boolean;
  timeout?: boolean;
  detail?: string;
}
export const limitsMs: Record<Workload, number> = { access: 2000, waivers: 6000, training: 6000, health: 2000 };

export function summarize(samples: Sample[]) {
  const sorted = samples.map(s => s.elapsedMs).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return {
    requests: samples.length,
    errors: samples.filter(s => !s.ok).length,
    falseGrants: samples.filter(s => s.falseGrant).length,
    timeouts: samples.filter(s => s.timeout).length,
    sloViolations: samples.filter(s => s.elapsedMs >= limitsMs[s.workload]).length,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1) ?? null,
    failures: samples.filter(s => !s.ok || s.elapsedMs >= limitsMs[s.workload]).slice(0, 5)
      .map(({ workload, elapsedMs, detail }) => ({ workload, elapsedMs, detail })),
  };
}

// Always join every worker before fixture teardown, even when a worker fails.
export async function concurrent(count: number, concurrency: number, work: (index: number) => Promise<void>) {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(concurrency) || concurrency < 1)
    throw Error('Invalid worker count');
  let next = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) await work(next++);
  }));
  const failure = outcomes.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export function stageResult(name: string, concurrency: number, elapsedMs: number, samples: Sample[]) {
  const summary = summarize(samples);
  return {
    name, concurrency, elapsedMs, requestsPerSecond: samples.length / (elapsedMs / 1000),
    ...summary,
    workloads: Object.fromEntries((['access', 'waivers', 'training', 'health'] as Workload[])
      .filter(kind => samples.some(s => s.workload === kind))
      .map(kind => [kind, summarize(samples.filter(s => s.workload === kind))])),
    passed: samples.length > 0 && summary.errors === 0 && summary.falseGrants === 0 && summary.sloViolations === 0,
  };
}

export function stableLatency(first: number | null, last: number | null) {
  // Compare equal-concurrency runs, with a 100 ms allowance for local timing noise.
  return first !== null && last !== null && last <= Math.max(first * 2, first + 100);
}
