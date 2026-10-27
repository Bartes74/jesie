import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedInvalidRecipe, hasUnrecognisedDietaryIngredient, recipeGetRetryable, recipeIssuesAllowAutomaticRepair, recipeReceiptCanBeRead, recipeValidationIssues } from './recipe-recovery-policy';

const invalid = { kind: 'recipe', provider: 'openai', status: 'failed' as const, errorCode: 'AI_RESULT_INVALID', providerRequestId: 'resp_existing', providerFinishedAt: new Date(), costBasis: 'usage', chargedUsd: '.25', result: null };
test('only a confirmed charged invalid recipe can authorize a new repair', () => {
  assert.equal(confirmedInvalidRecipe(invalid), true);
  for (const change of [{ status: 'uncertain' as const }, { providerRequestId: null }, { providerFinishedAt: null }, { costBasis: 'reservation' }, { chargedUsd: null }, { errorCode: 'AI_PROVIDER_QUOTA' }, { result: {} }, { kind: 'hero' }])
    assert.equal(confirmedInvalidRecipe({ ...invalid, ...change }), false);
});
test('recovery can re-read a receipt without authorizing a second POST', () => {
  assert.equal(recipeReceiptCanBeRead(invalid), true);
  assert.equal(recipeReceiptCanBeRead({ ...invalid, status: 'uncertain' }), true);
  assert.equal(recipeReceiptCanBeRead({ ...invalid, providerRequestId: null }), false);
  assert.equal(recipeGetRetryable('AI_PROVIDER_STATUS_UNAVAILABLE'), true);
  for (const code of ['AI_PROVIDER_AUTH_REQUIRED', 'AI_PROVIDER_QUOTA', 'AI_PROVIDER_RECEIPT_UNAVAILABLE', 'AI_SUBMISSION_UNCERTAIN']) assert.equal(recipeGetRetryable(code), false);
});
test('validation feedback is bounded before persistence and display', () => {
  const result = recipeValidationIssues(Array.from({ length: 100 }, () => ({ field: 'x'.repeat(1000), message: 'm'.repeat(1000) })));
  assert.equal(result.length, 20); assert.equal(result[0].field.length, 160); assert.equal(result[0].message.length, 500);
});

const unknownIngredient = { field: 'ingredients.blue_fenugreek.name', message: 'Brak lokalnej klasyfikacji.', code: 'DIET_INGREDIENT_UNRECOGNISED' };
const legacyUnknownIngredient = { field: 'ingredients.aubergine.name', message: 'Doprecyzuj rzeczywisty podstawowy skład produktu, aby można było przypisać kategorię dania. Unrecognised ingredient: its dietary suitability needs an explicit review or a more precise ingredient name. Zachowaj zamysł i składniki przepisu.' };

test('local dietary vocabulary gaps do not authorize paid repairs, including mixed failures', () => {
  for (const issue of [unknownIngredient, legacyUnknownIngredient]) {
    assert.equal(hasUnrecognisedDietaryIngredient([issue]), true);
    assert.equal(recipeIssuesAllowAutomaticRepair([issue]), false);
    assert.equal(recipeIssuesAllowAutomaticRepair([{ field: 'timingPlan.tasks', message: 'Missing chilling interval.' }, issue]), false);
  }
  assert.equal(recipeIssuesAllowAutomaticRepair([]), false);
});

test('real dietary conflicts and ambiguous product formulations remain repairable', () => {
  for (const issue of [
    { field: 'diet', message: 'A vegan recipe cannot contain dairy.' },
    { field: 'ingredients.stock.name', message: 'A compound ingredient has an unspecified composition; specify its animal-free formulation for a vegetarian or vegan recipe.' },
    { field: 'ingredients.cheese.name', message: 'Cheese must specify vegetarian or microbial rennet in the base ingredient, rather than only as an optional substitution.' },
    { field: 'timingPlan.tasks', message: 'Include the required resting interval.' },
  ]) {
    assert.equal(hasUnrecognisedDietaryIngredient([issue]), false);
    assert.equal(recipeIssuesAllowAutomaticRepair([issue]), true);
  }
});

test('legacy vocabulary detection is limited to the exact classifier diagnostic and ingredient field', () => {
  for (const issue of [
    { field: 'steps.slice.text', message: legacyUnknownIngredient.message },
    { field: 'ingredients.stock.name', message: 'Unknown composition; specify whether the stock is animal or vegetable.' },
    { ...legacyUnknownIngredient, code: 'DIET_COMPOSITION_UNSPECIFIED' },
  ]) assert.equal(hasUnrecognisedDietaryIngredient([issue]), false);
});

test('structured vocabulary codes survive the bounded persisted feedback', () => {
  assert.deepEqual(recipeValidationIssues([unknownIngredient]), [unknownIngredient]);
  assert.deepEqual(recipeValidationIssues([{ ...unknownIngredient, code: 'a'.repeat(1000) }]),
    [{ field: unknownIngredient.field, message: unknownIngredient.message }]);
});
