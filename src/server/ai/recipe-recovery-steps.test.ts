import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ProviderError } from './provider-error';
import { AiError } from './errors';
import { recipeGetRetryable } from './recipe-recovery-policy';

class RetryableError extends Error { constructor(message: string, public options?: unknown) { super(message); } }
class TrendError extends Error {}
function harness(options: { image?: boolean; failure?: ProviderError; ambiguous?: boolean; repair?: boolean; noReceipt?: boolean; dictionaryGap?: boolean } = {}) {
  const calls: string[] = []; const failures: Array<Record<string, unknown>> = []; let reads = 0;
  const job = { id: 'job', kind: options.image ? 'hero' : 'recipe', model: 'model', input: {}, brief: 'brief', targetId: null, status: options.noReceipt ? 'uncertain' : 'generating', provider: options.image ? 'fal' : 'openai', providerRequestId: options.noReceipt ? null : 'resp_existing', result: null, reuseSourceJobId: null };
  const imports: Record<string, unknown> = {
    workflow: { RetryableError }, '@/lib/trend-polling': { trendRunLimits: { statusRetries: 2 } },
    './store': {
      claimSubmission: async () => ({ job: options.repair || options.ambiguous ? { ...job, status: 'submitting', providerRequestId: null } : job, shouldSubmit: Boolean(options.repair || options.ambiguous) }),
      attachProviderRequest: async (_id: string, receipt: string) => { calls.push(`attach:${receipt}`); },
      getJobForExecution: async () => job, ensureSubmissionAllowed: async () => { calls.push('preflight'); }, resolveIngredientReuse: async () => true,
      finishRecipe: async (_id: string, _content: unknown, cost: unknown) => { calls.push('finish:recipe'); assert.deepEqual(cost, { chargedUsd: '.12' }); },
      finishAsset: async () => { calls.push('finish:image'); }, failJob: async (_id: string, failure: Record<string, unknown>) => { failures.push(failure); },
      settleCost: async () => {}, confirmNotSubmitted: async () => {}, markProviderTerminal: async () => {},
    },
    './text-provider': {
      submitText: async () => { calls.push('POST:new'); throw new ProviderError('AI_SUBMISSION_UNCERTAIN', 'ambiguous', true); },
      submitTextRepair: async (_model: string, _input: unknown, _brief: string, previous: string, issues: unknown, before: () => Promise<void>, key: string) => {
        assert.equal(previous, 'resp_parent'); assert.deepEqual(issues, [{ field: 'slug.pl', message: 'Popraw slug.' }]); assert.equal(key, 'recipe-job-job');
        await before(); calls.push('POST:repair'); return 'resp_repaired';
      },
      pollText: async (_model: string, receipt: string, _input: unknown, ancestors: string[]) => {
        calls.push(`GET:${receipt}`); assert.deepEqual(ancestors, options.repair ? ['resp_parent'] : []);
        if (options.failure && reads++ === 0) throw options.failure;
        return { done: true, content: {}, cost: { chargedUsd: '.12' } };
      },
    },
    './image-provider': { pollImage: async (_model: string, receipt: string) => { calls.push(`GET:${receipt}`); if (options.failure && reads++ === 0) throw options.failure; return { done: true, asset: {}, cost: { chargedUsd: '.12' } }; }, imageBill: async () => null },
    './image-actions': { stepFormatModel: 'local-format', filledHeroModel: 'local-fill' }, './provider-error': { ProviderError },
    '@/server/media/capacity': { ensurePhotoStorageAvailable: async () => {} },
    './result-recovery-error': { photoResultRecoveryError: (error: unknown) => error instanceof ProviderError ? error : null,
      isTransientPhotoResultRead: (error: unknown) => error instanceof ProviderError && error.code === 'AI_IMAGE_DOWNLOAD_UNAVAILABLE' },
    './recipe-recovery-state': { recipeRecoverySubmission: async (_id: string, scope?: { forSubmission?: boolean }) => {
      if (options.dictionaryGap && scope?.forSubmission) throw new ProviderError('RECIPE_DIET_VOCABULARY_UNSUPPORTED', 'Local dictionary gap.');
      return { repair: options.repair ? { previousResponseId: 'resp_parent', issues: [{ field: 'slug.pl', message: 'Popraw slug.' }] } : null, ancestorRequestIds: options.repair ? ['resp_parent'] : [] };
    } },
    './recipe-recovery': {}, './recipe-recovery-policy': { recipeGetRetryable }, './errors': { AiError }, '@/server/trends/store': { TrendError },
    './manual-hero-recovery': {},
    './recipe-ingredient-resolution': { resolveRecipeIngredients: async () => ({ pending: false, dictionary: new Map(), notes: [], sources: [] }) },
  };
  const exports: Partial<typeof import('./steps')> = {};
  const code = ts.transpileModule(readFileSync(new URL('./steps.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, console, require: (path: string) => { assert.ok(Object.hasOwn(imports, path), path); return imports[path]; } });
  return { calls, failures, poll: () => exports.pollGeneration!('job'), submit: () => exports.submitGeneration!('job'), retries: exports.submitGeneration!.maxRetries };
}
test('a transient text GET backs off, then finishes the same receipt without a new POST', async () => {
  const h = harness({ failure: new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', 'temporary', true) });
  await assert.rejects(h.poll(), RetryableError); assert.equal(h.failures.length, 0);
  assert.equal(await h.poll(), true); assert.deepEqual(h.calls, ['GET:resp_existing', 'GET:resp_existing', 'finish:recipe']);
});
test('a completed image CDN GET503 retries and finishes the same image', async () => {
  const h = harness({ image: true, failure: new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', '503', true) });
  await assert.rejects(h.poll(), RetryableError); assert.equal(h.failures.length, 0);
  assert.equal(await h.poll(), true); assert.deepEqual(h.calls, ['GET:resp_existing', 'GET:resp_existing', 'finish:image']);
});
test('auth/quota stop with the existing receipt; confirmed invalid persists repair feedback', async () => {
  for (const code of ['AI_PROVIDER_AUTH_REQUIRED', 'AI_PROVIDER_QUOTA']) {
    const h = harness({ failure: new ProviderError(code, 'action required', true) }); assert.equal(await h.poll(), true);
    assert.equal(h.failures[0].uncertain, true); assert.equal(h.failures[0].providerFinished, false);
  }
  const h = harness({ failure: new ProviderError('AI_RESULT_INVALID', 'invalid', false, '.12', { issues: [{ field: 'steps', message: 'Uzupełnij kroki.' }], repairable: true }) });
  assert.equal(await h.poll(), true); assert.equal(h.failures[0].chargedUsd, '.12');
  assert.deepEqual(JSON.parse(JSON.stringify(h.failures[0].validation)), { issues: [{ field: 'steps', message: 'Uzupełnij kroki.' }], repairable: true });
});
test('a repair submits once with its parent receipt and final preflight', async () => {
  const h = harness({ repair: true }); assert.equal(await h.submit(), true);
  assert.deepEqual(h.calls, ['preflight', 'POST:repair', 'attach:resp_repaired']); assert.equal(h.retries, 0);
});
test('an ambiguous POST is never automatically repeated and an unlinked uncertainty cannot submit', async () => {
  const h = harness({ ambiguous: true }); assert.equal(await h.submit(), false); assert.deepEqual(h.calls, ['POST:new']); assert.equal(h.failures[0].uncertain, true);
  const unknown = harness({ noReceipt: true }); assert.equal(await unknown.submit(), false); assert.deepEqual(unknown.calls, []);
});
test('a legacy queued dictionary repair stops before POST while an accepted receipt remains readable', async () => {
  const h = harness({ repair: true, dictionaryGap: true });
  assert.equal(await h.submit(), false); assert.deepEqual(h.calls, []);
  assert.equal(h.failures[0].code, 'RECIPE_DIET_VOCABULARY_UNSUPPORTED');
  assert.equal(h.failures[0].chargedUsd, '0'); assert.equal(h.failures[0].uncertain, false);
  const accepted = harness({ repair: true, dictionaryGap: true });
  assert.equal(await accepted.poll(), true);
  assert.deepEqual(accepted.calls, ['GET:resp_existing', 'finish:recipe']);
});
