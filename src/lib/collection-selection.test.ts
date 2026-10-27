import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCollectionShopping, collectionSelectionKey, EMPTY_COLLECTION_SELECTION, isCollectionSelection, removeCollectionRecipe, selectCollectionRecipe } from './collection-selection';
import { recipes, type Ingredient } from './recipes';
import { toPublicRecipe } from './recipe-presentation';

const milk: Ingredient = { id: 'milk', name: { pl: 'Mleko', en: 'Milk' }, amount: { kind: 'exact', value: '100' }, unit: 'ml', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } };
const recipe = (id: string, ingredient = milk) => toPublicRecipe({ ...recipes[0], id, baseServings: 2, ingredients: [ingredient] });

test('collection selection supports more than three dishes, independent portions and isolated storage', () => {
  let state = EMPTY_COLLECTION_SELECTION;
  for (let i = 0; i < 12; i++) state = selectCollectionRecipe(state, `recipe-${i}`, 2);
  assert.equal(state.recipes.length, 12);
  assert.equal(isCollectionSelection(state), true);
  state = selectCollectionRecipe(state, 'recipe-3', 8);
  assert.equal(state.recipes.length, 12);
  assert.equal(state.recipes[3].servings, 8);
  assert.equal(removeCollectionRecipe(state, 'recipe-3').recipes.length, 11);
  assert.notEqual(collectionSelectionKey('christmas'), collectionSelectionKey('easter'));
  assert.equal(EMPTY_COLLECTION_SELECTION.recipes.length, 0);
});

test('shopping sums quantities for each dish, omits unavailable recipes and renews changed quantity check keys', () => {
  let state = selectCollectionRecipe(selectCollectionRecipe(EMPTY_COLLECTION_SELECTION, 'a', 2), 'b', 4);
  state = selectCollectionRecipe(state, 'withdrawn', 3);
  const shopping = buildCollectionShopping(state, [recipe('a'), recipe('b')]);
  assert.deepEqual(shopping.items[0].amount, { kind: 'exact', value: '300' });
  assert.deepEqual(shopping.unavailable.map(item => item.recipeId), ['withdrawn']);
  const changed = buildCollectionShopping(selectCollectionRecipe(state, 'a', 4), [recipe('a'), recipe('b')]);
  assert.notEqual(shopping.items[0].id, changed.items[0].id);
});

test('shopping does not combine incompatible units or infer density', () => {
  const state = selectCollectionRecipe(selectCollectionRecipe(EMPTY_COLLECTION_SELECTION, 'a', 2), 'b', 2);
  const shopping = buildCollectionShopping(state, [recipe('a'), recipe('b', { ...milk, unit: 'g' })]);
  assert.equal(shopping.items.length, 2);
  assert.deepEqual(shopping.items.map(item => item.unit).sort(), ['g', 'ml']);
});

test('selection rejects invalid portions and corrupt storage, and snapshots shopping choices', () => {
  const choices = { optionalIngredientIds: ['herb'], substitutions: {}, includeOwnedProductIds: [] };
  const state = selectCollectionRecipe(EMPTY_COLLECTION_SELECTION, 'a', 4, choices);
  choices.optionalIngredientIds.push('salt');
  assert.deepEqual(state.recipes[0].selection.optionalIngredientIds, ['herb']);
  assert.equal(selectCollectionRecipe(state, 'a', 25), state);
  for (const invalid of [null, {}, { recipes: [null], checked: [] }, { ...state, recipes: [...state.recipes, ...state.recipes] }, { ...state, checked: [false] }]) assert.equal(isCollectionSelection(invalid), false);
});

test('changing a selected substitution replaces the original ingredient and rescales its own quantity', () => {
  const dish = { ...recipe('a'), substitutions: [{ id: 'oat', ingredientId: 'milk', name: { pl: 'Napój owsiany', en: 'Oat drink' }, amount: { kind: 'exact' as const, value: '75' }, unit: 'ml' as const, scaling: 'linear' as const, note: { pl: '', en: '' }, status: 'approved' as const }] };
  const original = selectCollectionRecipe(EMPTY_COLLECTION_SELECTION, 'a', 4);
  const updated = selectCollectionRecipe(original, 'a', 4, { optionalIngredientIds: [], substitutions: { milk: 'oat' }, includeOwnedProductIds: [] });
  const shopping = buildCollectionShopping(updated, [dish]);
  assert.equal(shopping.items.length, 1);
  assert.equal(shopping.items[0].name.pl, 'Napój owsiany');
  assert.deepEqual(shopping.items[0].amount, { kind: 'exact', value: '150' });
  assert.deepEqual(buildCollectionShopping(original, [dish]).items[0].amount, { kind: 'exact', value: '200' });
});

test('teaspoon and tablespoon quantities merge through volume units', () => {
  const state = selectCollectionRecipe(selectCollectionRecipe(EMPTY_COLLECTION_SELECTION, 'a', 2), 'b', 2);
  const shopping = buildCollectionShopping(state, [recipe('a', { ...milk, unit: 'tsp', amount: { kind: 'exact', value: '1' } }), recipe('b', { ...milk, unit: 'tbsp', amount: { kind: 'exact', value: '1' } })]);
  assert.equal(shopping.items.length, 1);
  assert.equal(shopping.items[0].unit, 'ml');
  assert.deepEqual(shopping.items[0].amount, { kind: 'exact', value: '20' });
});
