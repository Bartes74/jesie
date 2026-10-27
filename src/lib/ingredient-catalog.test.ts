import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIngredientCatalog, canonicalizeProductIds, expandOwnedProducts, ingredientProductIds } from './ingredient-catalog';
import type { Ingredient } from './recipes';

const ingredient = (pl: string, en: string): Ingredient => ({ id: 'product', name: { pl, en }, amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } });

test('an unknown product keeps its identity after an English translation correction', () => {
  const original = ingredient('pasta z tamaryndowca', 'tamarind puree');
  const corrected = ingredient('pasta z tamaryndowca', 'tamarind paste');
  assert.deepEqual(ingredientProductIds(original), ingredientProductIds(corrected));
  const catalog = buildIngredientCatalog([{ ingredients: [corrected] }]);
  assert.deepEqual(canonicalizeProductIds(['literal:pasta z tamaryndowca|tamarind puree'], catalog), ingredientProductIds(corrected));
});

test('migration collapses aliases but never merges conflicting known translations', () => {
  assert.deepEqual(canonicalizeProductIds(['milk', 'literal:mleko|milk', 'literal:mleko krowie|cow milk']), ['milk']);
  assert.deepEqual(canonicalizeProductIds(['literal:mleko|coconut milk']), ['literal:mleko|coconut milk']);
  assert.deepEqual(ingredientProductIds(ingredient('mleko', 'coconut milk')), ['literal:mleko|coconut milk']);
  assert.deepEqual(canonicalizeProductIds(['coconut-milk', 'milk', 'oat-milk']), ['coconut-milk', 'milk', 'oat-milk']);
});

test('whole lemon covers juice and zest after migrating an old literal ID', () => {
  const owned = expandOwnedProducts(['literal:cytryna|lemon']);
  assert.ok(owned.has('lemon-juice') && owned.has('lemon-zest'));
  assert.equal(expandOwnedProducts(['lemon-juice']).has('lemon-zest'), false);
});
