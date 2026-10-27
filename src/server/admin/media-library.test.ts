import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { recipes } from '@/lib/recipes';
import { ingredientImageIdentity } from '@/server/ai/ingredient-profile';
import type { EditorialContent, EditorialActor } from '@/lib/editorial-types';

function harness(options: { missing?: boolean; failRead?: boolean; serverRevision?: number; misbound?: boolean } = {}) {
  const content: EditorialContent = { recipe: structuredClone(recipes[0]), author: '', originalText: '', sources: [], photos: { ingredients: {}, steps: {} } };
  const targetId = content.recipe.ingredients[0].id;
  const recipe = { id: content.recipe.id, revision: 5, content, editorialStatus: 'draft', deletedAt: null };
  const identity = ingredientImageIdentity(content.recipe.ingredients[0]);
  const asset = { id: 'image', kind: 'ingredient', recipeId: recipe.id, targetId, blobPathname: 'photo.webp', alt: { pl: 'Produkt', en: 'Product' }, caption: { pl: '', en: '' }, width: 512, height: 512, createdAt: new Date() };
  const tables = { assets: {}, jobs: {}, catalog: {}, recipes: {} };
  const saved: Array<{ expectedRevision: number; content: EditorialContent; actor: EditorialActor }> = [];
  let reads = 0;
  class EditorialError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
  const db = { select: (fields: Record<string, unknown>) => {
    let table: unknown;
    const query = { from: (next: unknown) => { table = next; return query; }, innerJoin: () => query, where: () => query, orderBy: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => resolve(table === tables.assets ? 'path' in fields ? [{ path: asset.blobPathname }] : [{ asset, input: content, jobKind: options.misbound ? 'step' : asset.kind, jobRecipeId: asset.recipeId, jobTargetId: asset.targetId }]
        : table === tables.recipes ? [recipe] : [{ ...identity, assetId: asset.id, eligibility: 'approved' }]) };
    return query;
  } };
  const mocks: Record<string, unknown> = {
    'server-only': {}, '@/server/db': { getDb: () => db },
    '@/server/ai/schema': { aiAssets: tables.assets, aiJobs: tables.jobs, ingredientImages: tables.catalog },
    '@/server/db/schema': { editorialRecipes: tables.recipes },
    '@/server/editorial/store': { EditorialError, getRecipe: async () => recipe, saveRecipe: async (_id: string, input: { expectedRevision: number; content: EditorialContent }, actor: EditorialActor) => {
      if (options.serverRevision && options.serverRevision !== input.expectedRevision) throw new EditorialError(409, 'REVISION_CONFLICT', 'Nowsza wersja');
      if (actor.id !== 'owner') throw new EditorialError(403, 'FORBIDDEN', 'Brak dostępu');
      saved.push({ ...input, actor }); return { ...recipe, revision: 6, content: input.content };
    } },
    '@/server/media/storage': { getMediaBlob: async () => { reads++; if (options.failRead) throw new Error('offline'); return options.missing ? null : { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.close(); } }) }; } },
  };
  const realRequire = createRequire(import.meta.url);
  const exports: Partial<typeof import('./media-library')> = {};
  const code = ts.transpileModule(readFileSync(new URL('./media-library.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  runInNewContext(code, { exports, structuredClone, console, require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name) });
  const actor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' as const };
  const input = { recipeId: recipe.id, kind: 'ingredient' as const, targetId, imageId: 'image', expectedRevision: 5 };
  return { run: (override = {}, account: EditorialActor = actor) => exports.reuseLibraryImage!({ ...input, ...override }, account), saved, reads: () => reads };
}

test('stale and invalid targets stop before reading an external image or saving', async () => {
  const h = harness();
  await assert.rejects(h.run({ expectedRevision: 4 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(h.run({ targetId: 'deleted' }), { code: 'INVALID_TARGET' });
  assert.equal(h.reads(), 0); assert.equal(h.saved.length, 0);
});
test('missing or unreadable source media never changes the draft', async () => {
  for (const options of [{ missing: true }, { failRead: true }]) {
    const h = harness(options);
    await assert.rejects(h.run(), { code: 'IMAGE_UNAVAILABLE' }); assert.equal(h.saved.length, 0);
  }
});
test('reuse preserves the final revision/actor guard and creates no paid work', async () => {
  const h = harness(); await h.run();
  assert.equal(h.reads(), 1); assert.equal(h.saved.length, 1); assert.equal(h.saved[0].expectedRevision, 5); assert.equal(h.saved[0].actor.id, 'owner');
  const changed = harness({ serverRevision: 6 }); await assert.rejects(changed.run(), { code: 'REVISION_CONFLICT' }); assert.equal(changed.saved.length, 0);
  const forbidden = harness(); await assert.rejects(forbidden.run({}, { id: 'disabled', name: '', email: '', role: 'admin' }), { code: 'FORBIDDEN' }); assert.equal(forbidden.saved.length, 0);
});
test('a library asset with a conflicting source-job kind is unavailable before a media read', async () => {
  const h = harness({ misbound: true });
  await assert.rejects(h.run(), { code: 'INCOMPATIBLE_IMAGE' });
  assert.equal(h.reads(), 0); assert.equal(h.saved.length, 0);
});
