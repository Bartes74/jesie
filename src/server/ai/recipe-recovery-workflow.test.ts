import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(file: string, imports: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (path: string) => { assert.ok(Object.hasOwn(imports, path), path); return imports[path]; } });
  return exports;
}

test('explicit recipe recheck reads the same receipt with paid ingredient research disabled and never admits repairs', async () => {
  const calls: string[] = []; let reads = 0;
  const exports = load('../../workflows/recipe-recheck.ts', {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'recheck' }), sleep: async () => { calls.push('wait'); } },
    '@/server/ai/steps': {
      claimGenerationRecovery: async () => { calls.push('claim'); return true; },
      pollGeneration: async (id: string, existingOnly: boolean) => { assert.equal(id, 'retained'); assert.equal(existingOnly, true); calls.push('read'); return ++reads === 2; },
      expireGeneration: async () => { calls.push('retain'); },
    },
  });
  await exports.recipeRecheck('retained', 3);
  assert.deepEqual(calls, ['claim', 'read', 'wait', 'read']);
});

test('a duplicate recheck never reads, and exhausted GET retries preserve the original receipt', async () => {
  for (const duplicate of [true, false]) {
    const calls: string[] = [];
    const exports = load('../../workflows/recipe-recheck.ts', {
      workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'recheck' }), sleep: async () => {} },
      '@/server/ai/steps': { claimGenerationRecovery: async () => !duplicate,
        pollGeneration: async () => { calls.push('read'); throw new Error('GET retries exhausted'); },
        expireGeneration: async () => { calls.push('retain'); } },
    });
    await exports.recipeRecheck('retained', 3);
    assert.deepEqual(calls, duplicate ? [] : ['read', 'retain']);
  }
});
function generation(options: { duplicate?: boolean; repairs?: number; transient?: boolean; cutout?: 'owned' | 'other-worker'; cutoutFailure?: boolean; cutoutAdmissionFailure?: boolean; cutoutExpiryFailure?: boolean } = {}) {
  const events: string[] = []; let next = 0;
  const exports = load('../../workflows/ai-generation.ts', {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'worker' }), sleep: async (duration: string) => { events.push(`sleep:${duration}`); } },
    '@/server/ai/recipe-recovery-policy': { recipeRepairLimit: 2, recipeRepairBackoff: ['10s', '1m'] },
    '@/server/ai/steps': {
      claimGenerationRecovery: async (id: string) => { events.push(`claim:${id}`); return !options.duplicate; },
      submitGeneration: async (id: string) => { events.push(`submit:${id}`); if(id==='sam'&&options.cutoutFailure)throw new Error('Unknown SAM acceptance'); return true; },
      pollGeneration: async (id: string) => { events.push(`read:${id}`); if (options.transient) throw new Error('GET attempts exhausted'); return true; },
      expireGeneration: async (id: string) => { events.push(`retain:${id}`);if(id==='sam'&&options.cutoutExpiryFailure)throw new Error('Cutout state storage unavailable'); }, reconcileGeneration: async (id: string) => { events.push(`bill:${id}`);return true; },
      prepareManualHeroCutout: async (id: string) => { events.push(`cutout:${id}`);if(options.cutoutAdmissionFailure)throw new Error('Admission read unavailable');return id==='original'&&options.cutout?{jobId:'sam',created:true,run:options.cutout==='owned'}:null; },
      advanceGenerationRecovery: async (id: string) => next < (options.repairs ?? 0) ? { jobId: `repair${++next}`, generation: 1, attempt: next, continue: true } : { jobId: id, continue: false },
    },
  });
  return { run: () => exports.aiGeneration('original', 1), events };
}
test('manual generation follows at most two durable children with bounded backoff', async () => {
  const h = generation({ repairs: 2 }); await h.run();
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:original', 'submit:repair1', 'submit:repair2']);
  assert.ok(h.events.includes('sleep:1m')); assert.equal(h.events.filter(event => event === 'sleep:10s').length, 4);
});
test('a duplicate worker stops before any generation or receipt read', async () => {
  const h = generation({ duplicate: true }); await h.run(); assert.deepEqual(h.events, ['claim:original']);
});
test('read retry exhaustion retains the accepted request without buying another job', async () => {
  const h = generation({ transient: true }); await h.run();
  assert.deepEqual(h.events.filter(event => event.startsWith('submit:')), ['submit:original']); assert.ok(h.events.includes('retain:original'));
});
test('manual photograph uses one separately billed SAM child and never rerenders or loops the correction', async () => {
  const h=generation({cutout:'owned'});await h.run();
  assert.deepEqual(h.events.filter(event=>event.startsWith('submit:')),['submit:original','submit:sam']);
  assert.deepEqual(h.events.filter(event=>event.startsWith('cutout:')),['cutout:original']);
  assert.deepEqual(h.events.filter(event=>event.startsWith('bill:')),['bill:sam','bill:original']);
});
test('another workflow keeps its correction and an unknown SAM acceptance never repeats POST', async () => {
  const other=generation({cutout:'other-worker'});await other.run();
  assert.deepEqual(other.events.filter(event=>event.startsWith('submit:')),['submit:original']);
  const unknown=generation({cutout:'owned',cutoutFailure:true});await unknown.run();
  assert.deepEqual(unknown.events.filter(event=>event.startsWith('submit:')),['submit:original','submit:sam']);
  assert.ok(unknown.events.includes('retain:sam'));
  assert.deepEqual(unknown.events.filter(event=>event.startsWith('bill:')),['bill:sam','bill:original']);
});
test('an unavailable correction admission preserves the source bill and manual fallback', async () => {
  const h=generation({cutoutAdmissionFailure:true});await h.run();
  assert.deepEqual(h.events.filter(event=>event.startsWith('submit:')),['submit:original']);
  assert.ok(h.events.includes('bill:original'));
});
test('a child state-write outage still reconciles the completed original photograph', async () => {
  const h=generation({cutout:'owned',cutoutFailure:true,cutoutExpiryFailure:true});await h.run();
  assert.deepEqual(h.events.filter(event=>event.startsWith('submit:')),['submit:original','submit:sam']);
  assert.ok(h.events.includes('bill:original'));
});
test('daily preparation applies the effective ready child through the existing run policy', async () => {
  const applied: string[] = []; const submitted: string[] = []; let repairs = 0;
  const exports = load('../../workflows/trends.ts', {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'daily' }), sleep: async () => {} },
    '@/lib/trend-polling': { trendJobPollDelays: [], trendRunLimits: {}, pollWithBackoff: async () => true },
    '@/server/ai/recipe-recovery-policy': { recipeRepairBackoff: ['10s', '1m'] },
    '@/server/ai/steps': { claimGenerationRecovery: async () => true, submitGeneration: async (id: string) => { submitted.push(id); }, pollGeneration: async () => true, reconcileGeneration: async () => {},
      advanceGenerationRecovery: async (id: string) => repairs++ === 0 ? { jobId: 'repair', generation: 1, attempt: 1, continue: true } : { jobId: id, continue: false } },
    '@/server/trends/steps': {}, '@/server/trends/preparation-steps': {
      prepareRadarText: async () => ({ state: 'job', jobId: 'original', submit: true }),
      preparationJobState: async (_run: string, _generation: number, id: string) => ({ status: id === 'original' ? 'failed' : 'ready', hasResult: id !== 'original' }),
      advanceRadarText: async (run: string, generation: number, id: string) => { assert.equal(run, 'run'); assert.equal(generation, 8); applied.push(id); return { state: 'complete' }; },
    },
  });
  assert.equal((await exports.prepareText('run', 8) as { state: string }).state, 'complete');
  assert.deepEqual(submitted, ['original', 'repair']); assert.deepEqual(applied, ['repair']);
});
