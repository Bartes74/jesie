import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { approvedImageModel, failedHeroSourcePrefix, heroCutoutModel } from './image-actions';

function fixture() {
  const recipe = structuredClone(recipes[0]);
  const input: EditorialContent = { recipe, originalText: '', author: '', sources: [], photos: { ingredients: {}, steps: {} },
    aiPhotography: { regenerate: true } };
  const source = { id: 'fb7aa019-ff25-4a44-bfc5-60029c38a740', recipeId: recipe.id, kind: 'hero', provider: 'fal', model: approvedImageModel,
    status: 'failed', errorCode: 'AI_TRANSPARENCY_MISSING', providerRequestId: 'accepted-photo', providerFinishedAt: new Date(),
    result: null, appliedRevision: null, trendRunId: null, photoBatchId: null, createdBy: 'owner', input };
  const child = { ...source, id: 'a020c89c-dc29-45c0-8aab-fe7db2581c85', model: heroCutoutModel,
    providerRequestId: 'accepted-mask' as string | null, status: 'generating', input: structuredClone(input) };
  child.input.recipe.image = `${failedHeroSourcePrefix}${source.id}`;
  child.input.aiPhotography!.automaticHeroCutout = { sourceJobId: source.id, workflowRunId: 'owner-run' };
  return { source, child, recipe: { id: recipe.id, content: structuredClone(input), editorialStatus: 'draft', deletedAt: null } };
}

function harness(values = fixture(), existing: ReturnType<typeof fixture>['child'] | null = null) {
  const queries: string[] = [];
  const rows = [[values.source], [values.recipe], existing ? [existing] : []];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: async (lock: string) => {
      queries.push(lock); return rows.shift() ?? assert.fail('No further database reads are needed.');
    } }) }) }),
  };
  const loadDependency = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync(new URL('./manual-hero-recovery.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Partial<typeof import('./manual-hero-recovery')> = {};
  runInNewContext(source, { exports,
    require: (name: string) => {
      if (name === 'server-only') return {};
      if (name === '@/server/db') return { getDb: () => ({ transaction: async (run: (transaction: typeof tx) => unknown) => run(tx) }) };
      if (name === './store') return { budgetLock: async () => {}, trustedActor: async () => ({ id: 'owner' }),
        createJobAdmission: () => assert.fail('Free-form composition recovery must never admit another paid mask.') };
      if (name === '@/server/db/schema') return { editorialRecipes: { id: 'recipe-id' } };
      if (name === './schema') return { aiJobs: { id: 'job-id', createdBy: 'creator', requestKey: 'request-key' } };
      return loadDependency(name);
    },
    fetch: () => assert.fail('Recovery admission cannot contact a provider.'),
  });
  assert(exports.admitManualHeroCutout);
  return { run: exports.admitManualHeroCutout, queries };
}

test('free-form manual compositions never infer or buy a vessel mask, even when the older vessel remains valid', async () => {
  for (const brief of ['Na deseczce z nożykiem.', 'In the original bowl.', 'On a serving slate with two spoons.']) {
    const values = fixture();
    Object.assign(values.source, { brief });
    const before = structuredClone(values);
    const h = harness(values);
    assert.equal(await h.run(values.source.id, 'owner-run'), null);
    assert.deepEqual(h.queries, ['update', 'share', 'update']);
    assert.deepEqual(values, before, 'The original receipt, input and recipe remain unchanged.');
  }
});

test('an accepted existing mask may finish with its owning worker; an unsubmitted mask cannot start', async () => {
  for (const requestId of ['accepted-mask', null]) {
    const values = fixture(); values.child.providerRequestId = requestId;
    const before = structuredClone(values);
    const h = harness(values, values.child);
    const operation = await h.run(values.source.id, 'owner-run');
    assert.equal(operation?.jobId, values.child.id); assert.equal(operation?.created, false);
    assert.equal(operation?.run, Boolean(requestId));
    assert.deepEqual(values, before);
  }
});

test('another worker, a failed mask or an unrelated source cannot trigger further mask work', async () => {
  const foreign = fixture();
  assert.equal((await harness(foreign, foreign.child).run(foreign.source.id, 'other-worker'))?.run, false);
  const failed = fixture(); failed.child.status = 'failed';
  assert.equal((await harness(failed, failed.child).run(failed.source.id, 'owner-run'))?.run, false);
  const mismatch = fixture(); mismatch.child.input.recipe.image = `${failedHeroSourcePrefix}204260ae-efcb-4320-b125-89ce7f9ddcbc`;
  assert.equal(await harness(mismatch, mismatch.child).run(mismatch.source.id, 'owner-run'), null);
});

test('automatic packages and recipes with changed food do not enter manual recovery', async () => {
  const automatic = fixture(); delete automatic.source.input.aiPhotography!.regenerate;
  const h = harness(automatic);
  assert.equal(await h.run(automatic.source.id, 'owner-run'), null);
  assert.deepEqual(h.queries, ['update']);
  const changed = fixture(); changed.recipe.content.recipe.description.pl += ' Changed recipe.';
  assert.equal(await harness(changed).run(changed.source.id, 'owner-run'), null);
});
