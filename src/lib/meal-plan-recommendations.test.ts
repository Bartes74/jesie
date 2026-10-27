import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes, type Ingredient } from './recipes';
import { toPublicRecipe, type PublicRecipe } from './recipe-presentation';
import { recommendPlanRecipes } from './meal-plan-recommendations';
import type { PlannedMeal } from './meal-plan';

const ingredient = (pl: string, en: string, id = pl): Ingredient => ({ id, name: { pl, en }, amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } });
const sample = (id: string, ingredients: Ingredient[], minutes = 20): PublicRecipe => ({ ...toPublicRecipe(recipes[0]), id, ingredients, times: { active: minutes, total: minutes, cooking: 0, rest: 0 } });
const plan = (...ids: string[]): PlannedMeal[] => ids.map(recipeId => ({ recipeId, servings: 4, selection: { optionalIngredientIds: [], substitutions: {}, includeOwnedProductIds: [] } }));
test('suggests shared canonical main products, ranked by overlap then time with deterministic ties', () => {
  const selected = sample('planned', [ingredient('mleko', 'milk'), ingredient('jajka', 'eggs')]);
  const onlySalt = sample('salt-only', [ingredient('sól', 'salt'), ingredient('pieprz czarny', 'black pepper'), ingredient('oliwa', 'olive oil')], 1);
  const records = [selected, sample('z-two', [ingredient('mleko krowie', 'cow milk'), ingredient('jajko', 'egg')], 30), sample('b-one', [ingredient('jajka', 'eggs')], 10), onlySalt, sample('a-one', [ingredient('mleko', 'milk')], 10), sample('slow-one', [ingredient('mleko', 'milk')], 40)];
  const result = recommendPlanRecipes(records, plan('planned'));
  assert.deepEqual(result.map(item => item.recipe.id), ['z-two', 'a-one', 'b-one']);
  assert.deepEqual(result[0].sharedProducts.map(item => item.id), ['eggs', 'milk']);
  assert.equal(result[0].sharedProducts.find(item => item.id === 'milk')?.name.en, 'Milk');
  assert.equal(result[0].sharedProducts.find(item => item.id === 'milk')?.name.pl, 'Mleko');
  assert.deepEqual(recommendPlanRecipes([...records].reverse(), plan('planned')).map(item => item.recipe.id), result.map(item => item.recipe.id));
});
test('one or two planned recipes contribute products, with no suggestions for empty or full plans', () => {
  const records = [sample('one', [ingredient('mleko', 'milk')]), sample('two', [ingredient('jajka', 'eggs')]), sample('both', [ingredient('mleko', 'milk'), ingredient('jajka', 'eggs')])];
  assert.deepEqual(recommendPlanRecipes(records, []), []);
  assert.deepEqual(recommendPlanRecipes(records, plan('one', 'two', 'both')), []);
  assert.deepEqual(recommendPlanRecipes(records, plan('one', 'two')).map(item => item.recipe.id), ['both']);
  assert.deepEqual(recommendPlanRecipes(records, plan('missing')), []);
});
test('salt, pepper, oils, optional products and cooking byproducts cannot create recommendations', () => {
  const salt = ingredient('sól', 'salt');
  const pepper = ingredient('pieprz czarny', 'black pepper');
  const oil = ingredient('oliwa', 'olive oil');
  const optional = { ...ingredient('mleko', 'milk'), note: { pl: 'opcjonalnie', en: 'optional' } };
  const byproduct = ingredient('woda z gotowania makaronu', 'pasta cooking water');
  const records = [sample('planned', [salt, pepper, oil, optional, byproduct]), sample('candidate', [salt, pepper, oil, ingredient('mleko', 'milk'), byproduct])];
  assert.deepEqual(recommendPlanRecipes(records, plan('planned')), []);
});
test('counts a duplicated ingredient only once and excludes already planned recipes', () => {
  const milk = ingredient('mleko', 'milk');
  const records = [sample('planned', [milk]), sample('next', [milk, { ...milk, id: 'milk-second-group' }])];
  const result = recommendPlanRecipes(records, plan('planned', 'planned'));
  assert.equal(result.length, 1);
  assert.equal(result[0].recipe.id, 'next');
  assert.equal(result[0].sharedProducts.length, 1);
});
test('recommendations reuse the deliberately selected approved substitution instead of the original product', () => {
  const selected = sample('planned', [ingredient('mleko', 'milk', 'milk')]);
  selected.substitutions = [{ id: 'oat-swap', ingredientId: 'milk', name: { pl: 'Napój owsiany', en: 'Oat milk' },
    amount: { kind: 'exact', value: '100' }, unit: 'ml', status: 'approved', note: { pl: 'Podgrzewaj delikatnie.', en: 'Warm gently.' } }];
  const records = [selected, sample('milk-dish', [ingredient('mleko', 'milk')]), sample('oat-dish', [ingredient('napój owsiany', 'oat milk')])];
  assert.deepEqual(recommendPlanRecipes(records, plan('planned')).map(item => item.recipe.id), ['milk-dish']);
  const selectedPlan = plan('planned');
  selectedPlan[0].selection.substitutions = { milk: 'oat-swap' };
  const result = recommendPlanRecipes(records, selectedPlan);
  assert.deepEqual(result.map(item => item.recipe.id), ['oat-dish']);
  assert.deepEqual(result[0].sharedProducts.map(item => item.id), ['oat-milk']);
  assert.equal(result[0].sharedProducts[0].name.en, 'Oat milk');
  assert.equal(selected.ingredients[0].name.en, 'milk');
});
