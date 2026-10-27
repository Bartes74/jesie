import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { recipes } from '@/lib/recipes';
import { heroPresentationProfile, resolveHeroPresentation } from '@/lib/hero-presentation';
import type { AiKind, AiResult } from '@/lib/ai-types';
import { jobPresentationDto, jobPresentationSelection, type JobPresentationRow } from './job-presentation';
import { jobDto } from './store';
import { aiJobs } from './schema';
import { legacyIngredientStyleProfile, paperIngredientStyleProfile, whiteIngredientStyleProfile } from './ingredient-profile';

type JobRow = typeof aiJobs.$inferSelect;
function fixture(kind: AiKind = 'hero'): JobRow {
  const recipe = structuredClone(recipes[0]);
  recipe.heroPresentation = resolveHeroPresentation(recipe)!;
  return {
    id: 'fixture-job', manualContentApprovalHash: null, trendRunId: null, photoBatchId: null, recipeId: recipe.id,
    baseRevision: 7, kind, targetId: kind === 'ingredient' ? recipe.ingredients[0].id : null,
    status: 'applied', provider: 'fal', model: 'fixture-model', brief: 'Saved brief',
    requestKey: 'private-request-key', inputHash: 'private-input-hash', ingredientKey: null,
    reuseSourceJobId: 'source-job', ingredientResolvedAt: null,
    input: {
      recipe, originalText: 'private editorial source '.repeat(4000),
      author: 'Private editor', sources: [], photos: { ingredients: {}, steps: {} },
      kitchenTest: { date: '2026-10-12', tester: 'Private tester', notes: 'Private kitchen notes' },
      aiPhotography: { ingredientStyleProfile: paperIngredientStyleProfile, heroStyleProfile: heroPresentationProfile },
    },
    createdBy: 'private-owner-id', createdByName: 'Editor', providerRequestId: 'accepted-receipt',
    reservedUsd: '2.00000000', providerFinishedAt: new Date('2026-10-13T12:00:00Z'),
    chargedUsd: '1.25000000', costBasis: 'usage', usage: null, result: null,
    errorCode: null, errorMessage: null, appliedRevision: 8,
    createdAt: new Date('2026-10-13T11:00:00Z'), updatedAt: new Date('2026-10-13T12:00:00Z'),
  };
}

function projected(row: JobRow): JobPresentationRow {
  const { input, manualContentApprovalHash, trendRunId, photoBatchId, requestKey, inputHash, ingredientKey,
    ingredientResolvedAt, createdBy, providerFinishedAt, ...presentation } = row;
  void manualContentApprovalHash; void trendRunId; void photoBatchId; void requestKey; void inputHash; void ingredientKey;
  void ingredientResolvedAt; void createdBy; void providerFinishedAt;
  return {
    ...presentation, recipeTitle: input.recipe.title.pl,
    ingredientStyleProfile: input.aiPhotography?.ingredientStyleProfile ?? null,
    heroStyleProfile: input.aiPhotography?.heroStyleProfile ?? null,
    manualPhotoComposition: input.aiPhotography?.regenerate === true,
    heroContainer: input.aiPhotography?.heroPresentationOverride?.container ?? input.recipe.heroPresentation?.container ?? null,
  };
}

test('Studio list query projects only scalar input paths, never full editorial input', () => {
  const query = drizzle.mock().select(jobPresentationSelection).from(aiJobs)
    .where(eq(aiJobs.recipeId, 'fixture-recipe')).orderBy(desc(aiJobs.createdAt)).limit(100).toSQL();
  assert(!Object.hasOwn(jobPresentationSelection, 'input'));
  const inputSelections = [...query.sql.matchAll(/(?:"ai_job"\.)?"input"((?:->>?'[A-Za-z]+')+)/g)].map(match => match[1]);
  assert.deepEqual(inputSelections, [
    "->'recipe'->'title'->>'pl'", "->'aiPhotography'->>'ingredientStyleProfile'",
    "->'aiPhotography'->>'heroStyleProfile'", "->'aiPhotography'->>'regenerate'", "->'aiPhotography'->'heroPresentationOverride'->>'container'", "->'recipe'->'heroPresentation'->>'container'",
  ]);
  assert(!query.sql.includes('select *'));
  assert(query.sql.includes('"recipe_id" = $1'));
  assert.match(query.sql, /order by (?:"ai_job"\.)?"created_at" desc/);
  assert.deepEqual(query.params, ['fixture-recipe', 100]);
});

test('large private captured input is absent while polling retains the exact job display contract', () => {
  for (const kind of ['recipe', 'hero', 'ingredient', 'step'] as const) {
    const full = fixture(kind);
    const compact = projected(full);
    assert.deepEqual(jobPresentationDto(compact), jobDto(full));
    const text = JSON.stringify(compact);
    assert(!text.includes('private editorial source'));
    assert(!text.includes('Private kitchen notes'));
    assert(!text.includes('private-request-key'));
    assert(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(full)) / 20);
    const dto = jobPresentationDto(compact);
    assert.equal(dto.recipeTitle, full.input.recipe.title.pl);
    assert.equal(dto.providerRequestId, 'accepted-receipt');
    assert.equal(dto.reservedUsd, '2.00000000');
    assert.equal(dto.chargedUsd, '1.25000000');
    assert.equal(dto.costBasis, 'usage');
    assert.equal(dto.appliedRevision, 8);
    assert.equal(dto.createdAt, '2026-10-13T11:00:00.000Z');
    assert.equal(dto.heroContainer, kind === 'hero' ? full.input.recipe.heroPresentation?.container : undefined);
  }
});

test('ingredient results retain captured legacy, white and paper profiles for assets and library reuse', () => {
  for (const profile of [undefined, 'unknown-legacy-marker', whiteIngredientStyleProfile, paperIngredientStyleProfile]) {
    const full = fixture('ingredient');
    full.input.aiPhotography = profile ? { ingredientStyleProfile: profile } : undefined;
    const reusedPhoto = { src: '/media/library-photo', columns: 1, rows: 1, index: 0, alt: { pl: 'Cebula', en: 'Onion' } };
    full.result = {
      content: null, notes: ['Saved note'], reusedPhoto,
      asset: { id: 'fixture-asset', recipeId: full.recipeId, jobId: full.id,
        kind: 'ingredient', targetId: full.targetId, src: '/media/fixture-asset', width: 800, height: 800,
        alt: reusedPhoto.alt, caption: reusedPhoto.alt, model: full.model, createdAt: full.createdAt.toISOString() },
    } satisfies AiResult;
    const dto = jobPresentationDto(projected(full));
    const expected = [whiteIngredientStyleProfile, paperIngredientStyleProfile].includes(profile ?? '') ? profile : legacyIngredientStyleProfile;
    assert.equal(dto.result?.asset?.styleProfile, expected);
    assert.equal(dto.result?.reusedPhoto?.styleProfile, expected);
    assert.deepEqual(dto, jobDto(full));
    assert.equal(full.result.asset?.styleProfile, undefined);
  }
});

test('full recipe proposals and missing legacy hero metadata preserve their prior display shape', () => {
  const proposal = fixture('recipe');
  proposal.result = { content: structuredClone(proposal.input), asset: null, notes: ['Review needed'] };
  assert.deepEqual(jobPresentationDto(projected(proposal)).result, proposal.result);
  const hero = fixture('hero');
  hero.input.aiPhotography = undefined;
  assert(!Object.hasOwn(jobPresentationDto(projected(hero)), 'heroContainer'));
  hero.input.aiPhotography = { heroStyleProfile: heroPresentationProfile };
  hero.input.recipe.heroPresentation = undefined;
  assert(Object.hasOwn(jobPresentationDto(projected(hero)), 'heroContainer'));
  assert.equal(jobPresentationDto(projected(hero)).heroContainer, undefined);
});


test('hero vessel direction survives compact polling without exposing captured recipe data', () => {
  const full = fixture('hero');
  full.input.aiPhotography!.heroPresentationOverride = { ...full.input.recipe.heroPresentation!, container: 'clay-pot' };
  const compact = projected(full);
  assert.equal(jobDto(full).heroContainer, 'clay-pot');
  assert.deepEqual(jobPresentationDto(compact), jobDto(full));
  assert.equal(full.input.recipe.heroPresentation!.container, 'plate');
});

test('only manual retakes with requested props suppress vessel-cutout recovery controls', () => {
  for (const [brief, protectedComposition] of [['Gotowa potrawa na talerzu', false], ['Potrawa na deseczce z nożykiem.', true]] as const) {
    const full = fixture('hero'); full.brief = brief;
    full.input.aiPhotography = { ...full.input.aiPhotography, regenerate: true, heroRetakeVersion: 'complete-composition-v1' };
    const compact = projected(full);
    assert.equal(Boolean(jobDto(full).manualPhotoComposition), protectedComposition);
    assert.deepEqual(jobPresentationDto(compact), jobDto(full),'Historical complete-frame markers do not hide correction of a standard dish.');
  }
});
