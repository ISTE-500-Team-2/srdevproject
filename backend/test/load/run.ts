import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadFixture, type LoadMember } from './fixture.js';
import { concurrent, limitsMs, stableLatency, stageResult, type Sample, type Workload } from './metrics.js';

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'acceptance' }, users: { type: 'string' }, concurrency: { type: 'string' }, requests: { type: 'string' },
  duration: { type: 'string' }, output: { type: 'string', default: '../.local/load-results/latest.json' }, label: { type: 'string', default: 'candidate' },
} });
const profile = values.profile;
if (!['smoke', 'acceptance', 'soak'].includes(profile!)) throw Error('Profile must be smoke, acceptance or soak');
const integer = (value: string, name: string, max: number) => {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw Error(`${name} must be an integer from 1 to ${max}`);
  return Number(value);
};
const users = integer(values.users ?? (profile === 'smoke' ? '50' : '500'), 'users', 10000);
const concurrency = (values.concurrency ?? (profile === 'smoke' ? '10,25' : '25,50,100')).split(',').map(v => integer(v, 'concurrency', 500));
const requests = integer(values.requests ?? (profile === 'smoke' ? '100' : '500'), 'requests', 100000);
const durationSeconds = integer(values.duration ?? (profile === 'smoke' ? '10' : profile === 'soak' ? '3600' : '60'), 'duration', 86400);
const poolMax = integer(process.env.ARBOR_DB_POOL_MAX ?? '10', 'ARBOR_DB_POOL_MAX', 30);
if (users < 3 || users < Math.max(...concurrency) || requests < Math.max(...concurrency))
  throw Error('At least three users are required; users and requests must cover the largest concurrency');
const startedAt = new Date().toISOString();
const stages: ReturnType<typeof stageResult>[] = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let fixture: Awaited<ReturnType<typeof loadFixture>> | undefined;
let failure: string | undefined;
let stability: Record<string, unknown> & { passed: boolean } | undefined;
let counters: { events: number; allowed: number; checkIns: number; openVisits: number; falseGrants: number } | undefined;
let maxWaiting = 0;
const rssBefore = process.memoryUsage().rss;
try {
  fixture = await loadFixture(users, poolMax, durationSeconds);
  const { origin, members, certId, secret } = fixture;
  const request = async (workload: Workload, member: LoadMember, equipment = false): Promise<Sample> => {
    const started = performance.now();
    try {
      let url: string, init: RequestInit;
      if (workload === 'access') {
        const body = JSON.stringify({ uid: member.uid, eventId: randomUUID(), checkIn: true, renewal: false });
        const stamp = String(Date.now());
        url = '/api/devices/decision';
        init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-ID': equipment ? member.readerId : 'load-entrance', 'X-Reader-Timestamp': stamp,
          'X-Reader-Signature': createHmac('sha256', secret).update(stamp + '\n' + body).digest('hex') }, body };
      } else {
        url = workload === 'health' ? '/api/health' : `/api/me/${workload === 'waivers' ? 'waivers' : 'certifications'}`;
        init = { headers: { Authorization: `Bearer ${member.token}` } };
      }
      const response = await fetch(origin + url, { ...init, signal: AbortSignal.timeout(8000) });
      const body = await response.json() as any;
      let ok = response.status === 200, falseGrant = false;
      const timeout = body.data?.reason === 'VERIFICATION_TIMEOUT';
      if (workload === 'access') {
        const reason = member.missingWaiver ? 'WAIVER_REQUIRED' : equipment && member.missingTraining ? 'CERTIFICATION_REQUIRED' : 'ELIGIBLE';
        const allowed = reason === 'ELIGIBLE';
        falseGrant = body.data?.allowed === true && !allowed;
        ok &&= body.data?.allowed === allowed && body.data?.reason === reason && !!body.data?.decisionId;
        if (allowed) ok &&= body.data?.member?.id === member.id && body.data.leaseSeconds > 0 && body.data.leaseSeconds <= 5 && Date.parse(body.data.expiresAt) > Date.now();
        else ok &&= body.data?.member === null;
      } else if (workload === 'waivers') {
        ok &&= Array.isArray(body.data) && body.data.length > 0 && body.data.every((w: any) => w.signed === !(member.missingWaiver && w.scope === 'facility'));
      } else if (workload === 'training') {
        const certification = Array.isArray(body.data) ? body.data.find((c: any) => c.id === certId) : undefined;
        ok &&= member.missingTraining ? Array.isArray(body.data) && !certification : certification?.valid === true;
      } else ok &&= body.data?.status === 'ok';
      return { workload, elapsedMs: performance.now() - started, ok, falseGrant, timeout,
        ...(!ok ? { detail: `${response.status}: ${body.data?.reason ?? body.error?.code ?? 'unexpected validation result'}` } : {}) };
    } catch (error) {
      return { workload, elapsedMs: performance.now() - started, ok: false,
        timeout: error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name),
        detail: error instanceof Error ? error.name : 'request failed' };
    }
  };
  // Initialize reader registry, authentication/JIT and the HTTP connection pool before timing.
  for (const kind of ['access', 'waivers', 'training', 'health'] as Workload[]) {
    const warm = await request(kind, members[2]!, true);
    if (!warm.ok) throw Error(`Warmup failed: ${kind}: ${warm.detail}`);
  }
  loopDelay.enable();
  const sampler = setInterval(() => { maxWaiting = Math.max(maxWaiting, fixture!.pool.waitingCount); }, 20);
  try {
    const run = async (name: string, parallel: number, mixed: boolean) => {
      const samples: Sample[] = [];
      const start = performance.now();
      await concurrent(requests, parallel, async i => {
        const kind: Workload = mixed ? (['access', 'waivers', 'training', 'health'] as const)[i % 4]! : 'access';
        samples.push(await request(kind, members[(mixed ? Math.floor(i / 4) : i) % users]!, mixed));
      });
      const result = stageResult(name, parallel, performance.now() - start, samples);
      stages.push(result); console.log(JSON.stringify(result));
      return result;
    };
    const baseline = await run('baseline', concurrency[0]!, false);
    for (const parallel of concurrency) {
      await run(`entrance-burst-${parallel}`, parallel, false);
      await run(`mixed-${parallel}`, parallel, true);
    }
    const until = performance.now() + durationSeconds * 1000;
    let index = 0, window = 0;
    while (performance.now() < until) {
      await fixture.refreshSessions();
      const windowEnd = Math.min(until, performance.now() + 10000), samples: Sample[] = [];
      const start = performance.now();
      await concurrent(concurrency[0]!, concurrency[0]!, async () => {
        do {
          const i = index++;
          const kind = (['access', 'waivers', 'training', 'health'] as const)[i % 4]!;
          samples.push(await request(kind, members[Math.floor(i / 4) % users]!, true));
        } while (performance.now() < windowEnd);
      });
      const result = stageResult(`sustained-${++window}`, concurrency[0]!, performance.now() - start, samples);
      stages.push(result); console.log(JSON.stringify(result));
    }
    const recovery = await run('recovery', concurrency[0]!, false);
    const windows = stages.filter(s => s.name.startsWith('sustained-'));
    const first = windows[0]!;
    // A tiny tail window has a different request mix; compare complete windows.
    const last = windows.filter(s => s.elapsedMs >= Math.min(5000, first.elapsedMs / 2)).at(-1) ?? first;
    stability = {
      passed: stableLatency(baseline.p95Ms, recovery.p95Ms) && stableLatency(first.p95Ms, last.p95Ms)
        && last.requestsPerSecond >= first.requestsPerSecond * .8,
      baselineP95Ms: baseline.p95Ms, recoveryP95Ms: recovery.p95Ms,
      firstWindowP95Ms: first.p95Ms, lastWindowP95Ms: last.p95Ms,
      firstWindowRequestsPerSecond: first.requestsPerSecond, lastWindowRequestsPerSecond: last.requestsPerSecond,
      maxLatencyRatio: 2, latencyNoiseAllowanceMs: 100, minimumThroughputRatio: .8,
    };
    counters = (await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM app_device_access_event) AS events,
      (SELECT count(*)::int FROM app_device_access_event WHERE allowed) AS allowed,
      (SELECT count(*)::int FROM check_in WHERE statusdesc='Authenticated NFC eligibility decision') AS "checkIns",
      (SELECT count(*)::int FROM app_facility_visit WHERE checked_out_at IS NULL) AS "openVisits",
      (SELECT count(*)::int FROM app_device_access_event WHERE allowed AND
        (user_id=ANY($1::int[]) OR target_kind='equipment' AND user_id=ANY($2::int[]))) AS "falseGrants"`,
    [members.filter(m => m.missingWaiver).map(m => m.id), members.filter(m => m.missingTraining).map(m => m.id)])).rows[0];
  } finally { clearInterval(sampler); }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  loopDelay.disable();
  try { await fixture?.close(); }
  catch (error) { failure = `Cleanup failed: ${error instanceof Error ? error.message : error}`; }
  const auditIntegrity = !!counters && counters.allowed > 0 && counters.allowed === counters.checkIns && counters.falseGrants === 0;
  const passed = !failure && stages.length > 0 && stages.every(s => s.passed) && stability?.passed === true && auditIntegrity;
  const report = {
    schemaVersion: 1, label: values.label, startedAt, finishedAt: new Date().toISOString(), passed, failure,
    environment: { node: process.version, platform: process.platform, cpus: cpus().length, poolMax, localHttp: true },
    config: { profile, users, concurrency, requestsPerStage: requests, durationSeconds, limitsMs },
    stability, stages, counters, auditIntegrity,
    resources: { rssBefore, rssAfter: process.memoryUsage().rss, maxPoolWaiting: maxWaiting, eventLoopP99Ms: loopDelay.percentile(99) / 1e6 },
  };
  const output = path.resolve(values.output!);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Load test ${passed ? 'PASSED' : 'FAILED'}; report: ${output}`);
  if (failure) console.error(failure);
  if (!passed) process.exitCode = 1;
}
