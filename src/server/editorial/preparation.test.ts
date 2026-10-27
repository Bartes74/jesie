import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { PreparationInput } from './preparation';
import { heroPresentationReviewSchema } from '../../lib/hero-presentation-review';
import { readyPreparationAction } from '../../lib/preparation-client';

const actor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' as const };
const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true } as const;
const requestKey = '66b52789-d84d-4569-83a9-abdcc96b970e';

function isolated() {
  let approved = false;
  const recipe = { id: 'recipe', revision: 5, deletedAt: null, editorialStatus: 'draft', issues: [{ field: 'substitutions', message: 'Sprawdź zamienniki.' }], content: { recipe: { substitutions: [] as { status: string }[] } } };
  const jobs: Array<Record<string, unknown>> = [];
  const batches: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const dispatched: unknown[] = [];
  const presentationReviews: unknown[] = [];
  let pending = false;
  let compatible = true;
  class EditorialError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const read = () => ({ ...recipe });
  const mocks: Record<string, unknown> = {
    'server-only': {},
    'workflow/api': { start: async (...args: unknown[]) => { calls.push('dispatch-text'); dispatched.push(args); } },
    '@/workflows/ai-generation': { aiGeneration: () => {} },
    '@/lib/editorial-types': { reviewKeys: ['pl', 'en', 'quantities', 'method', 'photos', 'sources'] },
    '@/lib/hero-presentation-review': { heroPresentationReviewSchema },
    '@/server/db': { getDb: () => { const db = { select: (fields: Record<string, unknown>) => { const query = { from: () => query, where: () => query, limit: async () => 'input' in fields ? batches.map(batch => ({ id: batch.id, input: {} })) : pending ? [{ id: 'pending' }] : [] }; return query; }, transaction: async (fn: (db: unknown) => unknown) => fn(db) }; return db; } },
    '@/server/ai/schema': { aiJobs: {}, aiPhotoBatches: {} },
    '@/server/ai/photo-subject': { samePhotoSubject: () => compatible },
    './store': {
      EditorialError, getRecipe: async () => read(), getRecipeInTransaction: async () => read(), verifiedPublicationIssues: async (content: typeof recipe.content) => { assert(content.recipe.substitutions.every(item => item.status === 'approved')); return []; }, performRecipeActionInTransaction: async (_tx: unknown, _id: string, input: { action: string; checks: Record<string, boolean> }) => {
        assert.equal(input.action, 'approve_and_publish');
        assert.equal(Object.keys(input.checks).length, 6);
        assert(Object.values(input.checks).every(Boolean));
        calls.push('publish'); recipe.revision++;
      },
    },
    './content-approval': { isRecipeContentApproved: async () => approved, approveRecipeContent: async (_id: string, _revision: number, _actor: unknown, presentation?: unknown) => { presentationReviews.push(presentation); approved = true; calls.push('approve'); } },
    '@/server/ai/store': {
      budgetLock: async () => {},
      listJobs: async () => jobs, getJob: async (id: string) => jobs.find(job => job.id === id),
      createJobAdmission: async () => { const job = { id: requestKey, kind: 'recipe', recipeId: 'recipe', baseRevision: recipe.revision, status: 'queued' }; jobs.unshift(job); calls.push('create-text'); return { job, created: true }; },
      applyJob: async (id: string) => { calls.push('apply-text'); jobs.find(job => job.id === id)!.status = 'applied'; recipe.revision++; }, failJob: async () => { calls.push('uncertain'); },
    },
    '@/server/ai/photo-batch': {
      listPhotoBatches: async () => batches, getPhotoBatch: async (id: string) => batches.find(batch => batch.id === id),
      createPhotoBatch: async () => { calls.push('create-photos'); return { batch: { id: requestKey, status: 'queued' }, created: true, generation: 1 }; },
      applyPhotoBatch: async () => { calls.push('apply-photos'); },
    },
    '@/server/ai/photo-batch-dispatch': { dispatchPhotoBatch: async () => { calls.push('dispatch-photos'); } },
    '@/server/ai/photo-batch-recovery': { recoverPhotoBatch: async () => { calls.push('recover-photos'); return { dispatch: true, generation: 2 }; } },
    '@/server/ai/accepted-photo-batch-recovery': { recoverAcceptedPhotoBatchChildren: async (_id: string, account: typeof actor) => { assert.deepEqual(account, actor); calls.push('recover-receipts'); } },
  };
  const exports: Partial<typeof import('./preparation')> = {};
  const realRequire = createRequire(import.meta.url);
  const code = ts.transpileModule(readFileSync(new URL('./preparation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  runInNewContext(code, { exports, console, structuredClone, require: (name: string) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'zod' || name === 'drizzle-orm') return realRequire(name);
    throw new Error(`Unexpected external dependency: ${name}`);
  } });
  return { recipe, jobs, batches, calls, dispatched, presentationReviews, approve: () => { approved = true; }, pending: () => { pending = true; }, stale: () => { compatible = false; },
    run: (input: PreparationInput) => exports.prepareRecipe!('recipe', input, actor), read: () => exports.recipePreparation!('recipe'), schema: exports.preparationInput! };
}

test('a stopped unsent repair exposes its accepted parent for normal guided application without a new generation', async () => {
  const state = isolated();
  const parentId = 'f991d882-04c3-4e14-904a-6f085f65df52';
  state.jobs.push({ id: requestKey, recipeId: 'recipe', kind: 'recipe', baseRevision: 5, status: 'failed',
    recovery: { jobId: parentId, status: 'ready', canResume: false } },
  { id: parentId, recipeId: 'recipe', kind: 'recipe', baseRevision: 5, status: 'ready' });
  const prepared = await state.read();
  const action = readyPreparationAction(5, prepared.textJob, null);
  assert.deepEqual(action, { action: 'apply_text', jobId: parentId });
  assert(action);
  await state.run({ ...action, expectedRevision: 5 });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[1].status, 'applied');
  assert.deepEqual(state.calls, ['apply-text']);
});

test('a recovery reference cannot select another recipe or a different captured revision', async () => {
  for (const candidate of [
    { recipeId: 'other-recipe', baseRevision: 5 },
    { recipeId: 'recipe', baseRevision: 4 },
  ]) {
    const state = isolated();
    state.jobs.push({ id: requestKey, recipeId: 'recipe', kind: 'recipe', baseRevision: 5, status: 'failed',
      recovery: { jobId: 'parent' } }, { id: 'parent', kind: 'recipe', status: 'ready', ...candidate });
    assert.equal((await state.read()).textJob?.id, requestKey);
    assert.deepEqual(state.calls, []);
  }
});

test('reading/generating text neither admits photos nor publishes, and an active request is reused', async () => {
  const state = isolated();
  await state.run({ action: 'generate_text', expectedRevision: 5, requestKey });
  await state.run({ action: 'generate_text', expectedRevision: 5, requestKey });
  assert.deepEqual(state.calls, ['create-text', 'dispatch-text']);
});

test('photos and publication require prior approval of the current cooking text', async () => {
  const state = isolated();
  for (const action of ['generate_photos', 'publish'] as const) await assert.rejects(state.run(action === 'publish' ? { action, expectedRevision: 5, checks } : { action, expectedRevision: 5, requestKey }), { code: 'CONTENT_REVIEW_REQUIRED' });
  assert.deepEqual(state.calls, []);
  await state.run({ action: 'approve_content', expectedRevision: 5 });
  await state.run({ action: 'generate_photos', expectedRevision: 5, requestKey });
  assert.deepEqual(state.calls, ['approve', 'create-photos', 'dispatch-photos']);
});

test('a blocked photo packet recovers its existing receipts instead of creating another packet', async () => {
  const state = isolated(); state.approve();
  state.batches.push({ id: requestKey, recipeId: 'recipe', mode: 'missing', status: 'blocked', canResume: true });
  await state.run({ action: 'generate_photos', expectedRevision: 5, requestKey });
  assert.deepEqual(state.calls, ['recover-receipts', 'recover-photos', 'dispatch-photos']);
});

test('an incompatible ready packet never prevents admission of photos for newly approved content', async () => {
  const state = isolated(); state.approve(); state.stale();
  state.batches.push({ id: requestKey, recipeId: 'recipe', mode: 'missing', status: 'ready', baseRevision: 3 });
  await state.run({ action: 'generate_photos', expectedRevision: 5, requestKey });
  assert.deepEqual(state.calls, ['create-photos', 'dispatch-photos']);
});

test('stale versions and a result from another recipe never overwrite the current recipe', async () => {
  const state = isolated();
  await assert.rejects(state.run({ action: 'approve_content', expectedRevision: 4 }), { code: 'REVISION_CONFLICT' });
  state.jobs.push({ id: requestKey, recipeId: 'other-recipe', kind: 'recipe', status: 'ready' });
  await assert.rejects(state.run({ action: 'apply_text', jobId: requestKey, expectedRevision: 5 }), { code: 'RESULT_NOT_FOUND' });
  assert.deepEqual(state.calls, []);
});

test('a lost apply response is idempotent and does not apply the same content twice', async () => {
  const state = isolated();
  state.jobs.push({ id: requestKey, recipeId: 'recipe', kind: 'recipe', status: 'ready' });
  const action = { action: 'apply_text' as const, jobId: requestKey, expectedRevision: 5 };
  await state.run(action); await state.run(action);
  assert.equal(state.recipe.revision, 6);
  assert.deepEqual(state.calls, ['apply-text']);
});

test('only an explicit Publish invokes the complete publication gate, and pending receipts block it', async () => {
  const state = isolated(); state.approve();
  await state.run({ action: 'publish', expectedRevision: 5, checks });
  assert.deepEqual(state.calls, ['publish']);
  const pending = isolated(); pending.approve(); pending.pending();
  await assert.rejects(pending.run({ action: 'publish', expectedRevision: 5, checks }), { code: 'GENERATION_PENDING' });
  assert.deepEqual(pending.calls, []);
});

test('generation requires a durable request key and rejects unrelated action fields', () => {
  const state = isolated();
  assert.equal(state.schema.safeParse({ action: 'generate_text', expectedRevision: 5 }).success, false);
  assert.equal(state.schema.safeParse({ action: 'publish', expectedRevision: 5, requestKey }).success, false);
});

test('publication requires the explicit review decisions supplied by the reader', () => {
  const state = isolated();
  assert.equal(state.schema.safeParse({ action: 'publish', expectedRevision: 5 }).success, false);
  assert.equal(state.schema.safeParse({ action: 'publish', expectedRevision: 5, checks: { ...checks, en: false } }).success, false);
  assert.equal(state.schema.safeParse({ action: 'publish', expectedRevision: 5, checks }).success, true);
});

test('accepted substitutions do not falsely block the final preview while the saved draft stays unchanged', async () => {
  const state = isolated();
  state.recipe.content.recipe.substitutions.push({ status: 'to_review' });
  const next = await state.run({ action: 'approve_content', expectedRevision: 5 });
  assert.deepEqual(next.recipe.issues, []);
  assert.equal(state.recipe.content.recipe.substitutions[0].status, 'to_review');
  assert.deepEqual(state.calls, ['approve']);
});

test('one content approval carries only the visible vessel and appearance without admitting photos', async () => {
  const state = isolated();
  const heroPresentation = { container: 'glass' as const, finalAppearance: { pl: 'Jasny chłodnik w kieliszku z winogronami.', en: 'Pale soup in a glass topped with grapes.' } };
  const input = state.schema.parse({ action: 'approve_content', expectedRevision: 5, heroPresentation });
  await state.run(input);
  assert.deepEqual(state.presentationReviews, [heroPresentation]);
  assert.deepEqual(state.calls, ['approve']);
  assert.equal(state.schema.safeParse({ ...input, heroPresentation: { ...heroPresentation, evidenceStepIds: ['client-step'] } }).success, false);
  assert.equal(state.schema.safeParse({ ...input, heroPresentation: { ...heroPresentation, profileVersion: 'client-version' } }).success, false);
  assert.equal(state.schema.safeParse({ ...input, heroPresentation: { ...heroPresentation, finalAppearance: { ...heroPresentation.finalAppearance, en: '' } } }).success, false);
});
