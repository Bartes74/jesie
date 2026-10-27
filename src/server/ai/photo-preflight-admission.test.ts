import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { EditorialContent } from '@/lib/editorial-types';
import { heroPresentationProfile, heroPresentationIssue, resolveHeroPresentation, resolveHeroPresentationForBrief } from '@/lib/hero-presentation';
import { recipes } from '@/lib/recipes';
import { AiError } from './errors';
import * as ingredientProfile from './ingredient-profile';
import type { PhotoPromptSlot } from './photo-preflight';
import * as manualEditorialPolicy from '../trends/manual-editorial-policy';
import * as stepPhotoSelection from '@/lib/step-photo-selection';
import * as recipeDiet from '@/lib/recipe-diet';
import * as trendDietBalance from '../trends/diet-balance';

const loadDependency = createRequire(import.meta.url);

function fixture() {
  const recipe = structuredClone(recipes[0]);
  recipe.id = 'preflight-recipe';
  recipe.image = '';
  recipe.ingredients = [recipe.ingredients[0]];
  recipe.steps = [{ id: 'first-stage', title: { pl: 'Przygotuj', en: 'Prepare' }, text: { pl: 'Wymieszaj do połączenia.', en: 'Mix until combined.' } }];
  recipe.heroPresentation = {
    profileVersion: heroPresentationProfile, container: 'plate', evidenceStepIds: ['first-stage'],
    finalAppearance: { pl: 'Gotowa potrawa na talerzu.', en: 'The finished food on a plate.' },
  };
  const content: EditorialContent = {
    recipe, originalText: 'Private source retained in the saved draft.', author: 'Author', sources: [], photos: { ingredients: {}, steps: {} },
  };
  return { id: recipe.id, revision: 7, deletedAt: null, editorialStatus: 'draft', content };
}

function readQuery(rows: unknown[]) {
  const query = {
    where: () => query, for: () => query, orderBy: () => query, limit: () => query,
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

function harness() {
  const recipe = fixture();
  const run = { id: 'preflight-run', status: 'generating', generation: 3, recipeId: recipe.id, expectedRevision: recipe.revision, candidateId: null, packetRemainingUsd: '0', searchDiagnostics: { preparation: { requestKey: 'explicit-photo-request', generation: 3, approvedContentHash: 'e'.repeat(64), requestedBy: 'offline-owner' } } };
  const tables = {
    editorialRecipes: { name: 'recipes', id: 'recipes.id', deletedAt: 'recipes.deletedAt' },
    aiJobs: { name: 'jobs', id: 'jobs.id', recipeId: 'jobs.recipeId', trendRunId: 'jobs.trendRunId', createdAt: 'jobs.createdAt' },
    aiPhotoBatches: { name: 'batches', id: 'batches.id', createdBy: 'batches.createdBy', requestKey: 'batches.requestKey' },
    trendRuns: { name: 'runs', id: 'runs.id' }, trendCandidates: { name: 'candidates', id: 'candidates.id' },
  };
  const forbidden: string[] = [];
  const checks: { input: EditorialContent; slots: readonly PhotoPromptSlot[] }[] = [];
  const stop = new AiError(422, 'PHOTO_PROMPT_INVALID', 'Offline preflight rejection.');
  const deny = (name: string) => (): never => {
    forbidden.push(name);
    throw new Error(`Unexpected write or paid admission: ${name}`);
  };
  const database = {
    transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(database),
    select: () => ({ from: (table: unknown) => {
      if (table === tables.editorialRecipes) return readQuery([recipe]);
      if (table === tables.trendRuns) return readQuery([run]);
      if ([tables.aiJobs, tables.aiPhotoBatches, tables.trendCandidates].includes(table as typeof tables.aiJobs)) return readQuery([]);
      assert.fail('Unexpected fake read table.');
    } }),
    execute: async () => [], // Advisory locking only; this fake port has no database.
    insert: deny('insert'), update: deny('update'), delete: deny('delete'),
  };
  const preflight = {
    preflightPhotoPrompts: (input: EditorialContent, slots: readonly PhotoPromptSlot[]) => {
      checks.push({ input, slots });
      throw stop;
    },
  };
  const config = { aiSettings: () => ({ maxInputBytes: 60_000, imageReservationUsd: '2', fal: true, storage: true }) };
  const aiStore = {
    createJobAdmission: deny('admit-photo'), budget: deny('budget'), budgetLock: async () => {},
    trustedActor: async () => ({ id: 'offline-owner', name: 'Owner', role: 'owner' }),
  };
  const reused = {
    findReusableIngredient: async () => null, findIngredientProducer: async () => null, prepareLegacyIngredient: async () => {},
  };
  const editorial = { getRecipe: async () => recipe };
  const sql = () => ({});
  const orm = { sql, and: sql, desc: sql, eq: sql, gt: sql, gte: sql, inArray: sql, isNotNull: sql, isNull: sql, lte: sql };
  const ports: Record<string, unknown> = {
    'server-only': {}, 'drizzle-orm': orm,
    '@/lib/trend-polling': { trendRunLimits: { photographs: 40 } },
    '@/lib/trend-search-budget': {},
    '@/lib/step-photo-selection': stepPhotoSelection,
    '@/lib/recipe-diet': recipeDiet,
    '@/lib/recipe-photo-evidence': { isReviewedWrongStepPhoto: () => false },
    '@/lib/hero-presentation': { heroPresentationProfile, heroPresentationIssue, resolveHeroPresentation, resolveHeroPresentationForBrief },
    '@/lib/ai-types': {},
    '@/server/db': { getDb: () => database }, '@/server/db/schema': tables, '@/server/db/auth-schema': { user: {} },
    '@/server/ai/schema': tables, './schema': tables,
    '@/server/ai/config': config, './config': config,
    '@/server/ai/store': aiStore, './store': aiStore,
    '@/server/ai/ingredient-profile': ingredientProfile, './ingredient-profile': ingredientProfile,
    '@/server/ai/ingredient-reuse': reused, './ingredient-reuse': reused,
    '@/server/ai/photo-preflight': preflight, './photo-preflight': preflight,
    '@/server/ai/image-actions': {}, './image-actions': {},
    '@/server/ai/recipe-method': {},
    '@/server/editorial/store': editorial,
    '@/server/editorial/content-approval': { requireRecipeContentApproval: async () => {}, hasRecipeContentApproval: async () => true, contentApprovalHash: () => 'e'.repeat(64) },
    './manual-editorial-policy': manualEditorialPolicy,
    './diet-balance': trendDietBalance,
    '../trends/automation-takeover': { hasManualAutomationTakeover: async () => false },
    './photo-subject': {}, './errors': { AiError }, '@/server/ai/errors': { AiError },
    './ranking': {}, './selection': {}, './evidence': {}, './search': {}, './actor': { trendWorker: { id: 'offline-trend-worker' } },
  };
  function load(path: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    runInNewContext(source, {
      exports, Buffer, process: { env: {} }, structuredClone,
      require: (name: string) => {
        if (name === 'node:crypto' || name === 'node:util' || name === 'decimal.js') return loadDependency(name);
        if (name === './photo-preflight' && path === '../trends/store.ts') return load('../trends/photo-preflight.ts');
        assert(Object.hasOwn(ports, name), `Unexpected module dependency: ${name}`);
        return ports[name];
      },
    });
    return exports;
  }
  return { recipe, run, checks, forbidden, stop, load };
}

function assertCompletePlan(h: ReturnType<typeof harness>) {
  assert.equal(h.checks.length, 1);
  const { input, slots } = h.checks[0];
  assert.equal(input.recipe.id, h.recipe.id);
  assert.deepEqual(Array.from(new Set(Array.from(slots, slot => `${slot.kind}:${slot.targetId ?? ''}`))).sort(), [
    `ingredient:${h.recipe.content.recipe.ingredients[0].id}`, 'step:first-stage', 'hero:',
  ].sort());
  assert(slots.every(slot => typeof slot.brief === 'string' && slot.brief.length > 0));
  assert.deepEqual(h.forbidden, []);
}

test('real manually requested trend packet preflights the complete saved method before any admission', async () => {
  const h = harness();
  const store = h.load('../trends/store.ts');

  await assert.rejects(store.reserveTrendPhotos(h.run.id, h.run.generation), error => error === h.stop);

  assertCompletePlan(h);
});

test('real manually requested hero admission preflights the complete saved method without a prior packet', async () => {
  const h = harness();
  const store = h.load('../trends/store.ts');

  await assert.rejects(store.trendJob(h.run.id, 'hero', undefined, h.run.generation), error => error === h.stop);

  assertCompletePlan(h);
});

test('real manual packet creation preflights every planned photo before a budget or packet write', async () => {
  const h = harness();
  const store = h.load('./photo-batch.ts');

  await assert.rejects(store.createPhotoBatch({
    recipeId: h.recipe.id, expectedRevision: h.recipe.revision, requestKey: 'offline_preflight_request',
  }, { id: 'offline-owner', name: 'Owner', email: '', role: 'owner' }), error => error === h.stop);

  assertCompletePlan(h);
});
