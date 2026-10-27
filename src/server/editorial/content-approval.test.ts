import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { resolveHeroPresentation } from '@/lib/hero-presentation';
import { contentApprovalHash, recipeContentIssues, reviewedHeroPresentation } from './content-approval';
import { recipeDietIds } from '@/lib/recipe-diet';
import { normalizeIngredientVerificationName } from '@/lib/ingredient-verification';

function content(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.heroPresentation = resolveHeroPresentation(recipe)!;
  return { recipe, author: 'Redakcja', originalText: 'Notatki autora', sources: [{ id: 'source', title: 'Źródło', url: 'https://example.invalid/recipe' }], photos: { ingredients: {}, steps: {} } };
}

test('media and delivery metadata do not invalidate approval of cooking text', () => {
  const original = content(); const changed = structuredClone(original);
  changed.recipe.image = '/media/new-hero'; changed.recipe.imageAlt = { pl: 'Nowe zdjęcie', en: 'New photo' };
  changed.photos.ingredients.flour = { src: '/media/ingredient', columns: 1, rows: 1, index: 0, alt: { pl: 'Mąka', en: 'Flour' } };
  changed.photos.steps.cook = { src: '/media/step', columns: 1, rows: 1, index: 0, alt: { pl: 'Krok', en: 'Step' } };
  changed.aiPhotography = { ingredientStyleProfile: 'paper' }; changed.recipe.featured = !changed.recipe.featured;
  changed.recipe.collection = 'trends'; changed.recipe.trendConfirmedAt = '2026-10-16T00:00:00.000Z';
  assert.equal(contentApprovalHash(original), contentApprovalHash(changed));
});

test('ingredients, methods, final concept, original notes and evidence invalidate approval', () => {
  const original = content();
  const changes: ((value: EditorialContent) => void)[] = [
    value => { value.recipe.ingredients[0].name.en += ' changed'; },
    value => { value.recipe.steps[0].text.pl += ' Potem odcedź.'; },
    value => { value.recipe.heroPresentation!.finalAppearance.pl += ' Bez kawałków.'; },
    value => { value.originalText += ' Poprawione proporcje.'; },
    value => { value.sources[0].url = 'https://example.invalid/other'; },
  ];
  for (const change of changes) { const modified = structuredClone(original); change(modified); assert.notEqual(contentApprovalHash(original), contentApprovalHash(modified)); }
});

test('the ingredient-derived category preserves approval, while real ingredient or suitability changes still invalidate it', () => {
  const original = content(); delete original.recipe.diet;
  for (const diet of recipeDietIds) {
    const indexed = structuredClone(original); indexed.recipe.diet = diet;
    assert.equal(contentApprovalHash(indexed),contentApprovalHash(original),'Adding a derived index must not manufacture a new cooking review.');
    const renamed = structuredClone(indexed); renamed.recipe.ingredients[0].name = { pl: 'Masło', en: 'Butter' };
    assert.notEqual(contentApprovalHash(renamed),contentApprovalHash(indexed));
    const suitability = structuredClone(indexed);
    suitability.recipe.ingredients[0].note = { pl: 'Użyj sera z podpuszczką mikrobiologiczną.', en: 'Use cheese made with microbial rennet.' };
    assert.notEqual(contentApprovalHash(suitability),contentApprovalHash(indexed),'An ingredient formulation requirement remains real reviewed cooking text.');
  }
});

test('complete cooking text can be approved before any photo, but incomplete steps and sources cannot', () => {
  const original = content(); original.recipe.image = ''; original.recipe.imageAlt = { pl: '', en: '' };
  assert.deepEqual(recipeContentIssues(original), []);
  original.recipe.steps[0].text.en = '';
  assert(recipeContentIssues(original).some(issue => issue.field.startsWith('steps.')));
  original.recipe.steps[0].text.en = 'Use {{missing_ingredient}}.';
  assert(recipeContentIssues(original).some(issue => issue.message.includes('missing_ingredient')));
  original.sources[0].url = 'javascript:alert(1)';
  assert(recipeContentIssues(original).some(issue => issue.field === 'sources.source'));
});

test('content approval reuses trusted exact ingredient evidence and still checks changed formulations', () => {
  const original = content();
  original.recipe.ingredients[0].name = { pl: 'Kōji', en: 'Koji' };
  original.recipe.diet = 'vegetarian';
  const dictionary = new Map([[normalizeIngredientVerificationName('Kōji'), 'vegan' as const]]);
  const field = `ingredients.${original.recipe.ingredients[0].id}.name`;
  assert(recipeContentIssues(original).some(issue => issue.field === field));
  assert.deepEqual(recipeContentIssues(original, dictionary), []);
  original.recipe.ingredients[0].name = { pl: 'Koji sauce', en: 'Koji sauce' };
  dictionary.set(normalizeIngredientVerificationName('Koji sauce'), 'vegan');
  assert(recipeContentIssues(original, dictionary).some(issue => issue.field === field));
});

test('manual approval loads learned evidence from its transaction rather than trusting the stored diet label', async () => {
  for (const learned of [true, false]) {
    const original = content(); original.recipe.ingredients[0].name = { pl: 'Kōji', en: 'Koji' };
    original.recipe.diet = 'vegetarian';
    const row = { id: 'recipe', revision: 2, content: original, editorialStatus: 'draft' };
    const account = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' as const, disabled: false };
    const receipt = { recipeId: row.id, contentHash: 'hash', origin: 'manual', actorId: account.id, approvedAt: new Date() };
    let selections = 0, lookups = 0, inserted = 0;
    const tx = {
      execute: async () => {},
      select: () => {
        const values = [account, row, receipt][selections++];
        const query = { from: () => query, where: () => query, for: async () => [values],
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([values]).then(resolve) };
        return query;
      },
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => { inserted++; } }) }),
    };
    const realRequire = createRequire(import.meta.url);
    const exports: Partial<typeof import('./content-approval')> = {};
    const code = ts.transpileModule(readFileSync(new URL('./content-approval.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    runInNewContext(code, { exports, console, structuredClone, require: (name: string) => {
      if (name === '@/server/db') return { getDb: () => ({ transaction: async (action: (transaction: unknown) => unknown) => action(tx) }) };
      if (name === '../ai/recipe-ingredient-dictionary') return { getRecipeVerifiedAliases: async (ingredients: unknown, db: unknown) => {
        lookups++; assert.equal(ingredients, original.recipe.ingredients); assert.equal(db, tx);
        return learned ? new Map([[normalizeIngredientVerificationName('Kōji'), 'vegan']]) : new Map();
      } };
      return realRequire(name);
    } });
    const approval = exports.approveRecipeContent!(row.id, row.revision, account);
    if (learned) assert.equal((await approval).recipeId, row.id);
    else await assert.rejects(approval, (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'CONTENT_REVIEW_REQUIRED'));
    assert.equal(lookups, 1); assert.equal(inserted, learned ? 1 : 0);
  }
});

test('approval validates suggested substitutions before their final publication status changes', () => {
  const original = content();
  original.recipe.substitutions = [{ id: 'alternative', ingredientId: original.recipe.ingredients[0].id, name: { pl: 'Zamiennik', en: '' }, note: { pl: 'Użyj zamiast.', en: '' }, status: 'to_review' }];
  assert(recipeContentIssues(original).some(issue => issue.field.startsWith('substitutions.')));
});

test('saving the equivalent inferred final presentation preserves the approved food concept', () => {
  const original = content(); delete original.recipe.heroPresentation;
  const saved = structuredClone(original); saved.recipe.heroPresentation = resolveHeroPresentation(saved.recipe)!;
  assert.equal(contentApprovalHash(original), contentApprovalHash(saved));
});

test('visible presentation review retains valid generated evidence without exposing or mutating it', () => {
  const original = content(); const before = structuredClone(original);
  const reviewed = reviewedHeroPresentation(original, { container: 'glass', finalAppearance: { pl: 'Gotowe danie w kieliszku.', en: 'Finished food in a glass.' } });
  assert.deepEqual(reviewed.evidenceStepIds, original.recipe.heroPresentation!.evidenceStepIds);
  assert.equal(reviewed.container, 'glass');
  assert.deepEqual(original, before);
});

test('missing or stale private evidence is derived from the current method rather than requested from the editor', () => {
  const original = content();
  const visible = { container: 'bowl' as const, finalAppearance: { pl: 'Gotowa potrawa w misce.', en: 'The finished dish in a bowl.' } };
  original.recipe.heroPresentation = null;
  const expected = original.recipe.steps.map(step => step.id);
  assert.deepEqual(reviewedHeroPresentation(original, visible).evidenceStepIds, expected);
  original.recipe.heroPresentation = { ...reviewedHeroPresentation(original, visible), evidenceStepIds: ['removed-step'] };
  assert.deepEqual(reviewedHeroPresentation(original, visible).evidenceStepIds, expected);
  assert.throws(() => reviewedHeroPresentation(original, { ...visible, evidenceStepIds: ['client-step'] } as typeof visible), { code: 'INVALID_HERO_PRESENTATION' });
});

test('reviewing an equivalent legacy inferred presentation retains its approval identity', () => {
  const original = content(); delete original.recipe.heroPresentation;
  const legacy = resolveHeroPresentation(original.recipe)!;
  const reviewed = structuredClone(original);
  reviewed.recipe.heroPresentation = reviewedHeroPresentation(original, { container: legacy.container, finalAppearance: legacy.finalAppearance });
  assert.deepEqual(reviewed.recipe.heroPresentation.evidenceStepIds, legacy.evidenceStepIds);
  assert.equal(contentApprovalHash(reviewed), contentApprovalHash(original));
});
