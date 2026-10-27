import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(name: string, imports: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(new URL(`../../workflows/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  runInNewContext(output, { exports, require: (path: string) => {
    assert.ok(Object.hasOwn(imports, path), `Unexpected workflow dependency ${path}`);
    return imports[path];
  } });
  return exports;
}
function preparation(options: { duplicate?: boolean; unverified?: boolean; manualPhotoRequest?: boolean; preflightFailed?: boolean; preflightBlocked?: boolean; failedSlot?: string; unknownSlot?: string } = {}) {
  const events: string[] = [];
  const exports = load('daily-preparation', {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'offline-worker' }), sleep: async () => {} },
    '@/lib/trend-polling': { trendRunLimits: { billingAttempts: 1 }, trendSearchPollDelays: [], pollWithBackoff: async () => false },
    '@/server/trends/daily-preparation-steps': { claimDailyPreparation: async () => !options.duplicate },
    '@/server/trends/steps': {
      radarState: async () => ({ status: 'generating', recipeId: 'recipe', searchFinishedAt: 'done' }),
      submitRadar: async () => { throw new Error('An existing search must not be submitted'); },
      pollRadar: async () => { throw new Error('A finished search needs no polling'); },
      stopRadar: async (_run: string, _reason: string, uncertain: boolean) => { events.push(uncertain ? 'stop:uncertain' : 'stop'); },
      pendingRadarBills: async () => [],
      reserveRadarPhotos: async () => { events.push('photos:preflight'); if (options.preflightFailed) throw new Error('Photo preflight rejected the captured prompt.'); return { blocked: Boolean(options.preflightBlocked) }; },
    },
    '@/server/trends/preparation-steps': {
      approveRadarContent: async () => { events.push('content:approval'); return Boolean(options.manualPhotoRequest); },
      planRadarPreparation: async () => ({ slots: [{ kind: 'ingredient', targetId: 'i1' }, { kind: 'ingredient', targetId: 'i2' }, { kind: 'step', targetId: 's1' }, { kind: 'hero' }] }),
      finishRadarPreparation: async () => { events.push('complete'); },
    },
    './trends': {
      prepareText: async () => { events.push('text'); return { state: 'complete' }; },
      preparePhoto: async (_run: string, _generation: number, slot: { kind: string; targetId?: string }) => {
        const id = slot.targetId ?? slot.kind;
        events.push(`photo:${id}`);
        return { state: id === options.failedSlot ? 'failed' : id === options.unknownSlot ? 'blocked' : 'complete' };
      },
    },
    '@/server/ai/steps': { reconcileGeneration: async () => {} },
  });
  return { run: () => exports.prepareDailyRecipe('run', 1), events };
}

test('duplicate preparation delivery exits before researching or preparing paid jobs', async () => {
  const h = preparation({ duplicate: true }); await h.run(); assert.deepEqual(h.events, []);
});
test('an explicit photo request after content approval precedes ingredients, steps and the final dish photograph', async () => {
  const h = preparation({ manualPhotoRequest: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval', 'photos:preflight', 'photo:i1', 'photo:i2', 'photo:s1', 'photo:hero', 'complete']);
});
test('a qualified ordinary daily run stops after text without any photo preflight', async () => {
  const h = preparation(); await h.run(); assert.deepEqual(h.events, ['text', 'content:approval']);
});
test('unverified inspiration remains a text draft with no photo or publication work', async () => {
  const h = preparation({ unverified: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval']);
});
test('an invalid whole photo packet prevents every paid photograph', async () => {
  const h = preparation({ preflightFailed: true, manualPhotoRequest: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval', 'photos:preflight', 'stop']);
});
test('a saved preflight block exits before photographs without replacing its specific failure reason', async () => {
  const h = preparation({ preflightBlocked: true, manualPhotoRequest: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval', 'photos:preflight']);
});
test('a failed ingredient prevents later steps and the hero while preserving finished slots', async () => {
  const h = preparation({ failedSlot: 'i2', manualPhotoRequest: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval', 'photos:preflight', 'photo:i1', 'photo:i2', 'stop']);
});
test('an unresolved accepted receipt stops new spending without another search', async () => {
  const h = preparation({ unknownSlot: 's1', manualPhotoRequest: true }); await h.run();
  assert.deepEqual(h.events, ['text', 'content:approval', 'photos:preflight', 'photo:i1', 'photo:i2', 'photo:s1', 'stop:uncertain']);
});

function publication(statuses: string[], generation = 1) {
  const sleeps: (string | Date)[] = []; let releases = 0;
  const state = { date: '2026-10-12', dueAt: '2026-10-12T04:00:00.000Z', status: 'pending', generation,
    serverNow: '2026-10-12T00:00:00.000Z' };
  const exports = load('daily-publication', {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'offline-timer' }), sleep: async (value: string | Date) => { sleeps.push(value); } },
    '@/server/trends/publication-steps': {
      claimDailyPublisher: async () => true, dailyPublicationState: async () => state,
      releaseDailyRecipe: async () => { releases++; return { status: statuses.shift() ?? 'waiting', state }; },
    },
  });
  return { run: () => exports.publishDailyRecipe('2026-10-12', 1), sleeps, releases: () => releases };
}
test('publication sleeps until Warsaw six oclock and releases once with no provider dependencies', async () => {
  const h = publication(['published']); await h.run();
  assert.equal((h.sleeps[0] as Date).toISOString(), '2026-10-12T04:00:00.000Z');
  assert.equal(h.releases(), 1);
});
test('publication retry is bounded and a superseded timer never publishes', async () => {
  const h = publication([]); await h.run(); assert.equal(h.releases(), 13); assert.equal(h.sleeps.length, 13);
  const stale = publication(['published'], 2); await stale.run(); assert.equal(stale.releases(), 0);
});
