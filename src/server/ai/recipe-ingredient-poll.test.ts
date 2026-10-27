import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialContent } from '@/lib/editorial-types';
import { normalizeIngredientVerificationName, type IngredientVerificationProposal } from '@/lib/ingredient-verification';
import { inspectRecipeDiet, type RecipeDietId } from '@/lib/recipe-diet';
import { recipes } from '@/lib/recipes';
import { validateIngredientVerification } from './ingredient-verification-provider';
import { ProviderError } from './provider-error';
import { legacyRecipeProposalSchema, recipeResearchVersion } from './recipe-proposal';
import { pollText, type RecipeIngredientResolution } from './text-provider';
import { z } from 'zod';

const model = 'gpt-6-astra';
const receipt = 'resp_retained_unknown';
const primary = 'https://www.fao.org/test-fixture/teff';
const secondary = 'https://www.bbcgoodfood.com/test-fixture/teff';

function fixture(research = false) {
  const recipe = structuredClone(recipes[0]);
  const input: EditorialContent = {
    recipe, originalText: 'Prywatny opis autora.', author: 'Autorka przepisu',
    sources: [{ id: 'original', title: 'Źródło autora', url: 'https://example.invalid/original' }],
    photos: { ingredients: {}, steps: {} },
    aiPhotography: { recipeDietVersion: 'ingredient-diet-v1', ...(research ? { recipeResearchVersion } : {}) },
  };
  const raw: z.infer<typeof legacyRecipeProposalSchema> = {
    slug: recipe.slug, title: recipe.title, description: recipe.description,
    primaryCategory: recipe.primaryCategory, categories: recipe.categories, difficulty: recipe.difficulty,
    cuisine: recipe.cuisine, baseServings: recipe.baseServings, times: recipe.times,
    ingredients: [{ id: 'teff', name: { pl: 'teff', en: 'teff' },
      amount: { kind: 'exact', value: '100', approximate: false }, unit: 'g', scaling: 'linear',
      group: { pl: '', en: '' }, note: null }],
    steps: [{ id: 'prepare', title: { pl: 'Przygotuj', en: 'Prepare' },
      text: { pl: 'Przygotuj teff.', en: 'Prepare the teff.' }, timerMinutes: null }],
    equipment: recipe.equipment, tips: recipe.tips, storage: recipe.storage,
    scalingNote: recipe.scalingNote ?? null, notes: ['Założenie kulinarne.'], substitutions: [],
  };
  return { input, raw };
}

function researchedIdentity(): RecipeIngredientResolution {
  const proposed: IngredientVerificationProposal = {
    decision: 'verified', canonicalName: { pl: 'teff', en: 'teff' }, kind: 'plant', diet: 'vegan',
    suggestedName: null, reason: 'Fixture: established grain used in food.', confidence: 'high',
    sameIdentity: true, singleIngredient: true,
    sources: [
      { title: 'Institutional fixture', url: primary, supports: ['identity', 'culinary_use', 'diet'], finding: 'Fixture: identifies the grain and culinary use.' },
      { title: 'Independent fixture', url: secondary, supports: ['identity', 'culinary_use'], finding: 'Fixture: corroborates culinary identity.' },
    ],
  };
  const result = validateIngredientVerification([
    { type: 'web_search_call', id: 'search_identity', status: 'completed', action: { type: 'search', query: 'teff culinary identity',
      sources: [primary, secondary].map(url => ({ type: 'url', url })) } },
  ], proposed, { name: { pl: 'teff', en: 'teff' } });
  assert.equal(result.autoLearnEligible, true);
  const dictionary = new Map<string, RecipeDietId>();
  for (const name of [result.queriedNames.pl, result.queriedNames.en, result.canonicalName!.pl, result.canonicalName!.en])
    dictionary.set(normalizeIngredientVerificationName(name), result.diet!);
  return { pending: false, dictionary, notes: ['Potwierdzono składnik teff w źródłach.'],
    sources: result.sources.map((source, index) => ({ id: `ingredient_fixture_${index}`, title: source.title, url: source.url })) };
}

function completed(raw: unknown, research = false, usage = true) {
  return { id: receipt, object: 'response', status: 'completed',
    output: [
      ...(research ? [{ type: 'web_search_call', id: 'search_recipe', status: 'completed', action: { type: 'search',
        query: 'teff culinary method', sources: [{ type: 'url', url: secondary }] } }] : []),
      { type: 'message', id: 'msg_retained', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] },
    ], ...(usage ? { usage: { input_tokens: 10, output_tokens: 20 } } : {}) };
}

async function credentials(action: () => Promise<void>) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
  try { await action(); } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
}

test('a retained recipe waits for the dictionary, then validates the same receipt with the learned identity and original cost', async t => {
  await credentials(async () => {
    const { input, raw } = fixture();
    assert.equal(inspectRecipeDiet({ ingredients: raw.ingredients.map(item => ({ ...item, note: undefined })) }).uncertainIngredients.length, 1);
    const untouched = structuredClone(raw);
    const learned = researchedIdentity();
    const reads: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init);
      assert.equal(request.method, 'GET');
      assert.equal(request.url, `https://api.openai.com/v1/responses/${receipt}`);
      reads.push(request.url);
      return Response.json(completed(raw));
    });
    let resolutions = 0;
    const resolve = async (parsed: unknown): Promise<RecipeIngredientResolution> => {
      assert.deepEqual(parsed, raw); resolutions++;
      return resolutions === 1 ? { pending: true, dictionary: new Map(), notes: [], sources: [] } : learned;
    };
    assert.deepEqual(await pollText(model, receipt, input, [], resolve), { done: false });
    const done = await pollText(model, receipt, input, [], resolve);
    assert.equal(done.done, true);
    if (!done.done) assert.fail('Expected the retained recipe to complete.');
    assert.equal(done.content.recipe.diet, 'vegan');
    assert.deepEqual(done.content.recipe.ingredients[0].name, raw.ingredients[0].name);
    assert.deepEqual(done.content.sources, [...input.sources, ...learned.sources]);
    assert(done.notes.includes(learned.notes[0]));
    assert('chargedUsd' in done.cost);
    assert.equal(done.cost.chargedUsd, '0.00110000', 'The ingredient lookup is billed separately from the retained recipe.');
    assert.equal(reads.length, 2);
    assert.equal(resolutions, 2);
    assert.deepEqual(raw, untouched);
  });
});

test('researched recipes keep their actual research and ingredient evidence while only billing their own receipt', async t => {
  await credentials(async () => {
    const { input, raw } = fixture(true);
    const learned = researchedIdentity();
    const payload = { ...raw, researchSources: [{ title: 'Recipe research fixture', url: secondary }] };
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init);
      assert.equal(request.method, 'GET'); reads++;
      const parsed = new URL(request.url);
      assert.equal(parsed.origin, 'https://api.openai.com');
      assert.equal(parsed.pathname, `/v1/responses/${receipt}`);
      assert.deepEqual(parsed.searchParams.getAll('include[]'), ['web_search_call.action.sources']);
      return Response.json(completed(payload, true));
    });
    const result = await pollText(model, receipt, input, [], async () => learned);
    assert.equal(result.done, true);
    if (!result.done) assert.fail('Expected the researched recipe to complete.');
    assert.deepEqual(result.content.sources.map(source => source.url), [input.sources[0].url, secondary, primary]);
    assert('chargedUsd' in result.cost);
    assert.equal(result.cost.chargedUsd, '0.01110000');
    assert.equal(reads, 1);
  });
});

test('a transient dictionary read preserves the original paid recipe charge and retries only the retained GET', async t => {
  await credentials(async () => {
    const { input, raw } = fixture();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init);
      assert.equal(request.method, 'GET');
      assert.equal(request.url, `https://api.openai.com/v1/responses/${receipt}`); reads++;
      return Response.json(completed(raw));
    });
    await assert.rejects(pollText(model, receipt, input, [], async () => {
      throw new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', 'Fixture: temporary verification read failure.', true);
    }), error => error instanceof ProviderError && error.uncertain && !error.repairable
      && error.code === 'AI_PROVIDER_STATUS_UNAVAILABLE' && error.chargedUsd === '0.00110000');
    const result = await pollText(model, receipt, input, [], async () => researchedIdentity());
    assert.equal(result.done, true);
    assert.equal(reads, 2);
  });
});

test('completed recipe responses without usage keep billing unknown after successful ingredient resolution', async t => {
  await credentials(async () => {
    const { input, raw } = fixture();
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init);
      assert.equal(request.method, 'GET');
      assert.equal(request.url, `https://api.openai.com/v1/responses/${receipt}`);
      return Response.json(completed(raw, false, false));
    });
    const result = await pollText(model, receipt, input, [], async () => researchedIdentity());
    assert.equal(result.done, true);
    if (!result.done) assert.fail('Expected the recipe to complete with unknown billing.');
    assert.deepEqual(result.cost, {});
  });
});
