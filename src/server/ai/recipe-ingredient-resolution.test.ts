import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { ingredientEvidencePolicyVersion, normalizeIngredientVerificationName, type IngredientVerificationResult } from '@/lib/ingredient-verification';
import { buildRecipeProposal, legacyRecipeProposalSchema } from './recipe-proposal';
import { ProviderError } from './provider-error';
import { recipeIngredientResolver, type IngredientResolutionDependencies } from './recipe-ingredient-resolution';

function fixture(names = ['ajwain']) {
  const recipe = structuredClone(recipes[0]);
  recipe.ingredients = names.map((name, index) => ({ id: `ingredient_${index}`, name: { pl: name, en: name },
    amount: { kind: 'exact', value: '1' }, unit: 'tsp', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } }));
  recipe.steps = [{ id: 'prepare', title: { pl: 'Przygotuj i podaj', en: 'Prepare and serve' },
    text: { pl: 'Przygotuj składniki według przepisu i podaj.', en: 'Prepare the ingredients according to the recipe and serve.' } }];
  const content: EditorialContent = { recipe, author: 'Test', originalText: 'Ten oryginalny opis pozostaje bez zmian.', sources: [],
    photos: { ingredients: {}, steps: {} }, aiPhotography: { recipeDietVersion: 'ingredient-diet-v1' } };
  const raw = legacyRecipeProposalSchema.parse({ ...Object.fromEntries(Object.entries(recipe).filter(([key]) => key in legacyRecipeProposalSchema.shape)),
    ingredients: recipe.ingredients.map(item => ({ ...item, amount: { ...item.amount, approximate: false }, note: null })),
    steps: recipe.steps.map(item => ({ ...item, timerMinutes: null })), scalingNote: recipe.scalingNote ?? null, substitutions: [], notes: [] });
  return { content, raw };
}
function verified(name = 'ajwain'): IngredientVerificationResult {
  return { decision: 'verified', queriedNames: { pl: name, en: name }, canonicalName: { pl: name, en: name }, kind: 'plant', diet: 'vegan',
    suggestedName: null, reason: 'Potwierdzony składnik kulinarny.', sameIdentity: true, singleIngredient: true, confidence: 'high', autoLearnEligible: true,
    sources: [{ title: 'Institutional source fixture', url: 'https://www.fao.org/fixture', supports: ['identity', 'culinary_use', 'diet'], finding: 'Test evidence.' }] };
}
function harness(result = verified()) {
  let row: Awaited<ReturnType<IngredientResolutionDependencies['find']>> = null;
  const aliases = new Map<string, 'vegan' | 'vegetarian' | 'meat'>();
  const calls = { submit: 0, poll: 0, claim: 0, permission: 0, pending: 0, complete: 0, fail: 0 };
  const deps: IngredientResolutionDependencies = {
    aliases: async () => aliases, find: async () => row,
    checkPermission: async () => { calls.permission++; },
    claim: async input => {
      calls.claim++;
      if (row) return { verification: row, claimed: false };
      row = { key: 'saved-key', input, status: 'submitting', providerRequestId: null, result: null };
      return { verification: row, claimed: true, claimToken: 'token' };
    },
    submit: async () => { calls.submit++; return 'resp_ingredient'; },
    attach: async (_key, _token, receipt) => { row = { ...row!, status: 'generating', providerRequestId: receipt }; },
    poll: async receipt => { calls.poll++; assert.equal(receipt, 'resp_ingredient'); return { done: true, result, cost: { chargedUsd: '0.01', costBasis: 'usage' } }; },
    complete: async (_key, _receipt, value) => {
      calls.complete++; row = { ...row!, status: 'complete', result: value, learned: value.autoLearnEligible,
        errorCode: null, errorMessage: null, eligibilityPolicyVersion: ingredientEvidencePolicyVersion };
      if (value.autoLearnEligible && value.diet) for (const name of Object.values(value.queriedNames)) aliases.set(normalizeIngredientVerificationName(name), value.diet);
      return row;
    },
    fail: async (_row, _token, error) => { calls.fail++; row = { ...row!, status: error.uncertain ? 'uncertain' : 'failed', errorMessage: error.message }; },
    pending: async () => { calls.pending++; },
  };
  return { deps, calls, aliases, setRow: (value: NonNullable<typeof row>) => { row = value; } };
}

test('one claimed lookup resumes the retained recipe, learns exact names, and reuses the cached evidence', async () => {
  const { content, raw } = fixture(); const before = structuredClone(content);
  const h = harness(); const resolve = recipeIngredientResolver(content, h.deps);
  assert.equal((await resolve(raw)).pending, true);
  assert.equal(h.calls.submit, 1);
  const ready = await resolve(raw);
  assert.equal(ready.pending, false); assert.equal(h.calls.poll, 1); assert.equal(h.calls.complete, 1);
  const proposal = buildRecipeProposal(raw, content, ready.dictionary);
  assert.equal(proposal.content.recipe.diet, 'vegan');
  assert.equal(proposal.content.originalText, content.originalText);
  assert.equal(ready.sources[0].url, 'https://www.fao.org/fixture');
  const cached = await resolve(raw);
  assert.equal(cached.pending, false); assert.match(cached.notes[0], /zapamiętaną/);
  assert.equal(h.calls.submit, 1); assert.equal(h.calls.poll, 1);
  assert.deepEqual(content, before);
});

test('known and malformed recipes do not submit an ingredient lookup', async () => {
  for (const names of [['carrot'], ['ajwain']]) {
    const { content, raw } = fixture(names); const h = harness();
    await recipeIngredientResolver(content, h.deps)(names[0] === 'carrot' ? raw : { ingredients: raw.ingredients });
    assert.equal(h.calls.submit, 0); assert.equal(h.calls.claim, 0);
  }
});

test('one recognised translation cannot conceal an unfamiliar name in the other language', async () => {
  const { content, raw } = fixture(); const h = harness(); raw.ingredients[0].name.pl = 'pieprz';
  const pending = await recipeIngredientResolver(content, h.deps)(raw);
  assert.equal(pending.pending, true); assert.equal(h.calls.submit, 1);
});

test('previously learned unfamiliar foods do not block research of another new ingredient', async () => {
  const { content, raw } = fixture(['mahlab', 'amchur', 'ziziphus', 'ajwain']); const h = harness();
  for (const name of ['mahlab', 'amchur', 'ziziphus']) h.aliases.set(name, 'vegan');
  const pending = await recipeIngredientResolver(content, h.deps)(raw);
  assert.equal(pending.pending, true); assert.equal(h.calls.submit, 1);
});

test('a cached typo gives a correction suggestion without rewriting the recipe or buying another request', async () => {
  const { content, raw } = fixture(['ajwanx']);
  const typo = { ...verified('ajwanx'), decision: 'possible_typo' as const, suggestedName: { pl: 'ajwain', en: 'ajwain' }, autoLearnEligible: false };
  const h = harness(typo); const resolve = recipeIngredientResolver(content, h.deps);
  await resolve(raw);
  await assert.rejects(resolve(raw), error => error instanceof ProviderError && !error.repairable
    && error.issues[0].code === 'DIET_INGREDIENT_UNRECOGNISED' && /Możliwa literówka.*ajwain/.test(error.issues[0].message));
  await assert.rejects(resolve(raw), ProviderError);
  assert.equal(h.calls.submit, 1); assert.equal(h.aliases.size, 0); assert.equal(raw.ingredients[0].name.pl, 'ajwanx');
});

test('an uncertain POST is never repeated on a later resolver invocation', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.deps.submit = async () => { h.calls.submit++; throw new ProviderError('AI_INGREDIENT_VERIFICATION_SUBMISSION_UNCERTAIN', 'Brak potwierdzenia.', true); };
  const resolve = recipeIngredientResolver(content, h.deps);
  await assert.rejects(resolve(raw), ProviderError);
  await assert.rejects(resolve(raw), ProviderError);
  assert.equal(h.calls.submit, 1); assert.equal(h.calls.fail, 1);
});

test('a stale or cancelled recipe cannot start paid ingredient research', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.deps.checkPermission = async () => { throw new Error('stale'); };
  await assert.rejects(recipeIngredientResolver(content, h.deps)(raw), error => error instanceof ProviderError && !error.repairable);
  assert.equal(h.calls.claim, 0); assert.equal(h.calls.submit, 0);
});

test('a shared in-flight verification is polled without a second paid submission', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.setRow({ key: 'shared', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'generating', providerRequestId: 'resp_ingredient', result: null });
  const ready = await recipeIngredientResolver(content, h.deps)(raw);
  assert.equal(ready.pending, false); assert.equal(h.calls.submit, 0); assert.equal(h.calls.claim, 0); assert.equal(h.calls.poll, 1);
});

test('temporary receipt GET failures retain the request for a safe read retry', async () => {
  const { content, raw } = fixture(); const h = harness(); const resolve = recipeIngredientResolver(content, h.deps);
  await resolve(raw);
  h.deps.poll = async () => { throw new ProviderError('AI_INGREDIENT_VERIFICATION_READ_UNAVAILABLE', 'Spróbuj odczytu później.', true); };
  await assert.rejects(resolve(raw), error => error instanceof ProviderError && error.code === 'AI_PROVIDER_STATUS_UNAVAILABLE');
  assert.equal(h.calls.submit, 1); assert.equal(h.calls.fail, 0);
});

test('a model eligibility flag cannot approve a name if dictionary promotion was rejected', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.deps.complete = async (key, receipt, result) => ({ key, input: { name: result.queriedNames }, status: 'complete', providerRequestId: receipt, result, learned: false });
  const resolve = recipeIngredientResolver(content, h.deps); await resolve(raw);
  await assert.rejects(resolve(raw), error => error instanceof ProviderError && !error.repairable);
  assert.equal(h.aliases.size, 0);
});

test('an uncertain acknowledgement with a saved receipt recovers through GET and never submits again', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.setRow({ key: 'saved', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'uncertain', providerRequestId: 'resp_ingredient', result: null });
  const ready = await recipeIngredientResolver(content, h.deps)(raw);
  assert.equal(ready.pending, false); assert.equal(h.calls.submit, 0); assert.equal(h.calls.poll, 1);
});

test('a cached alias conflict remains reviewable even if another dictionary entry recognises the name', async () => {
  const { content, raw } = fixture(); const h = harness(); h.aliases.set('ajwain', 'meat');
  const conflict = { key: 'conflict', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'complete', providerRequestId: 'resp_ingredient',
    result: verified(), learned: false, errorCode: 'INGREDIENT_ALIAS_CONFLICT', errorMessage: 'Konflikt nazw wymaga sprawdzenia.',
    eligibilityPolicyVersion: ingredientEvidencePolicyVersion };
  h.setRow(conflict);
  h.deps.complete = async (key, receipt, result, cost) => {
    h.calls.complete++; assert.equal(key, conflict.key); assert.equal(receipt, conflict.providerRequestId);
    assert.deepEqual(result, conflict.result); assert.deepEqual(cost, {}); return conflict;
  };
  await assert.rejects(recipeIngredientResolver(content, h.deps)(raw), error => error instanceof ProviderError && /Konflikt nazw/.test(error.issues[0].message));
  assert.equal(h.calls.complete, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.poll, 0); assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.fail, 0); assert.deepEqual([...h.aliases], [['ajwain', 'meat']]);
});

test('a benign cached alias conflict resumes from saved facts without submitting or polling a provider', async () => {
  const { content, raw } = fixture(); const before = structuredClone({ content, raw }); const h = harness();
  const savedResult = verified();
  h.setRow({ key: 'retained-compatible', input: { name: savedResult.queriedNames }, status: 'complete', providerRequestId: 'resp_original_paid',
    result: savedResult, learned: false, errorCode: 'INGREDIENT_ALIAS_CONFLICT', errorMessage: 'Old duplicate-query conflict.',
    eligibilityPolicyVersion: ingredientEvidencePolicyVersion });
  h.deps.aliases = async () => new Map(h.aliases);
  const complete = h.deps.complete;
  h.deps.complete = async (key, receipt, result, cost) => {
    assert.equal(key, 'retained-compatible'); assert.equal(receipt, 'resp_original_paid');
    assert.deepEqual(result, savedResult); assert.deepEqual(cost, {});
    return complete(key, receipt, result, cost);
  };
  const resolve = recipeIngredientResolver(content, h.deps);
  const ready = await resolve(raw);
  assert.equal(ready.pending, false); assert.equal(ready.dictionary.get('ajwain'), 'vegan');
  assert.equal(ready.sources[0].url, savedResult.sources[0].url);
  assert.equal(buildRecipeProposal(raw, content, ready.dictionary).content.recipe.diet, 'vegan');
  await resolve(raw);
  assert.equal(h.calls.complete, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.poll, 0); assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.permission, 0); assert.equal(h.calls.fail, 0);
  assert.deepEqual({ content, raw }, before, 'Dictionary reconciliation must not rewrite the retained recipe.');
});

test('a local conflict reconciliation database failure is retryable without any provider or failure-state mutation', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.setRow({ key: 'retained-compatible', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'complete', providerRequestId: 'resp_original_paid',
    result: verified(), learned: false, errorCode: 'INGREDIENT_ALIAS_CONFLICT', errorMessage: 'Old duplicate-query conflict.',
    eligibilityPolicyVersion: ingredientEvidencePolicyVersion });
  h.deps.complete = async () => { h.calls.complete++; throw new Error('Temporary fixture database failure.'); };
  await assert.rejects(recipeIngredientResolver(content, h.deps)(raw), error => error instanceof ProviderError
    && error.code === 'AI_PROVIDER_STATUS_UNAVAILABLE' && error.uncertain);
  assert.equal(h.calls.complete, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.poll, 0); assert.equal(h.calls.claim, 0);
  assert.equal(h.calls.fail, 0); assert.equal(h.aliases.size, 0);
});

test('a concurrent completed verification refreshes an earlier dictionary snapshot', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.deps.aliases = async () => new Map(h.aliases);
  h.deps.find = async () => {
    h.aliases.set('ajwain', 'vegan');
    return { key: 'concurrent', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'complete', providerRequestId: 'resp_ingredient',
      result: verified(), learned: true };
  };
  const ready = await recipeIngredientResolver(content, h.deps)(raw);
  assert.equal(ready.pending, false); assert.equal(ready.dictionary.get('ajwain'), 'vegan');
  assert.equal(h.calls.submit, 0); assert.equal(h.calls.fail, 0);
});

test('a new evidence policy rechecks the existing paid receipt and caches the promoted result', async () => {
  const { content, raw } = fixture(); const h = harness();
  h.setRow({ key: 'old-policy', input: { name: { pl: 'ajwain', en: 'ajwain' } }, status: 'complete', providerRequestId: 'resp_ingredient',
    result: { ...verified(), autoLearnEligible: false }, learned: false, eligibilityPolicyVersion: 'ingredient-evidence-v1' });
  const resolve = recipeIngredientResolver(content, h.deps);
  const ready = await resolve(raw); assert.equal(ready.pending, false); assert.equal(ready.dictionary.get('ajwain'), 'vegan');
  await resolve(raw);
  assert.equal(h.calls.poll, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.claim, 0);
});
