import assert from 'node:assert/strict';
import test from 'node:test';
import { addMealIfAbsent, addPlannedMeal, buildMealPlanShopping, EMPTY_MEAL_PLAN, isMealPlan, removePlannedMeal } from './meal-plan';
import { EMPTY_SHOPPING_SELECTION } from './shopping';
import { recipes, type Ingredient } from './recipes';
import { toPublicRecipe } from './recipe-presentation';

const milk: Ingredient = { id: 'milk', name: { pl: 'Mleko', en: 'Milk' }, amount: { kind: 'exact', value: '100' }, unit: 'ml', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } };
const record = (id: string) => toPublicRecipe({ ...recipes[0], id, baseServings: 2, ingredients: [milk] });

test('plan admits at most three dishes, updates existing servings, and frees a slot on removal', () => {
  let plan = EMPTY_MEAL_PLAN;
  for (const id of ['a', 'b', 'c', 'd']) plan = addPlannedMeal(plan, id, 2);
  assert.deepEqual(plan.meals.map(meal => meal.recipeId), ['a', 'b', 'c']);
  plan = addPlannedMeal(plan, 'b', 4);
  assert.equal(plan.meals[1].servings, 4);
  assert.equal(plan.meals.length, 3);
  plan = addPlannedMeal(removePlannedMeal(plan, 'a'), 'd', 1);
  assert.deepEqual(plan.meals.map(meal => meal.recipeId), ['b', 'c', 'd']);
  assert.equal(addPlannedMeal(plan, 'b', 0), plan);
});

test('combined shopping uses each dishes portions, excludes owned stock, and reports unavailable dishes', () => {
  let plan = addPlannedMeal(addPlannedMeal(EMPTY_MEAL_PLAN, 'a', 2), 'b', 4);
  plan = addPlannedMeal(plan, 'withdrawn', 2);
  let result = buildMealPlanShopping(plan, [record('a'), record('b')], []);
  assert.deepEqual(result.buy[0].amount, { kind: 'exact', value: '300' });
  assert.deepEqual(result.unavailable.map(meal => meal.recipeId), ['withdrawn']);
  result = buildMealPlanShopping(plan, [record('a'), record('b')], ['literal:mleko|milk']);
  assert.equal(result.buy.length, 0);
  assert.deepEqual(result.owned[0].amount, { kind: 'exact', value: '300' });
  result = buildMealPlanShopping({ ...plan, includeOwnedProductIds: ['milk'] }, [record('a'), record('b')], ['milk']);
  assert.deepEqual(result.buy[0].amount, { kind: 'exact', value: '300' });
});

test('shopping choice snapshots cannot be mutated by subsequent detail changes', () => {
  const choice = { ...EMPTY_SHOPPING_SELECTION, optionalIngredientIds: ['herb'] };
  const plan = addPlannedMeal(EMPTY_MEAL_PLAN, 'a', 2, choice);
  choice.optionalIngredientIds.push('sugar');
  assert.deepEqual(plan.meals[0].selection.optionalIngredientIds, ['herb']);
});

test('catalog additions preserve an existing five-serving meal, substitutions and shopping checks exactly', () => {
  const selection = { optionalIngredientIds: ['herb'], substitutions: { milk: 'oat-drink' }, includeOwnedProductIds: ['milk'] };
  const plan = { ...addPlannedMeal(EMPTY_MEAL_PLAN, 'a', 5, selection), checked: ['bought-product'], includeOwnedProductIds: ['salt'] };
  const before = structuredClone(plan);
  assert.equal(addMealIfAbsent(plan, 'a', 2), plan);
  assert.deepEqual(plan, before);
  assert.equal(plan.meals[0].servings, 5);
});

test('a new catalog meal receives independent default shopping choices and preserves existing checks', () => {
  const plan = { ...EMPTY_MEAL_PLAN, checked: ['bought-product'], includeOwnedProductIds: ['salt'] };
  const next = addMealIfAbsent(plan, 'a', 3);
  assert.deepEqual(next.meals, [{ recipeId: 'a', servings: 3, selection: EMPTY_SHOPPING_SELECTION }]);
  assert.notEqual(next.meals[0].selection, EMPTY_SHOPPING_SELECTION);
  assert.equal(next.checked, plan.checked);
  assert.equal(next.includeOwnedProductIds, plan.includeOwnedProductIds);
  assert.deepEqual(plan.meals, []);
  assert.equal(isMealPlan(next), true);
});

test('catalog additions return the identical full plan without adding or resetting meals', () => {
  let plan = EMPTY_MEAL_PLAN;
  for (const id of ['a', 'b', 'c']) plan = addMealIfAbsent(plan, id, 5);
  const before = structuredClone(plan);
  assert.equal(addMealIfAbsent(plan, 'd', 2), plan);
  assert.equal(addMealIfAbsent(plan, 'b', 2), plan);
  assert.deepEqual(plan, before);
  assert.equal(addMealIfAbsent(EMPTY_MEAL_PLAN, 'a', 0), EMPTY_MEAL_PLAN);
});

test('corrupt local plans are rejected before rendering or calculation', () => {
  assert.equal(isMealPlan(addPlannedMeal(EMPTY_MEAL_PLAN, 'a', 2)), true);
  for (const value of [null, {}, { ...EMPTY_MEAL_PLAN, meals: [null] }, { ...EMPTY_MEAL_PLAN, meals: [{ recipeId: 'x', servings: 25, selection: EMPTY_SHOPPING_SELECTION }] }, { ...EMPTY_MEAL_PLAN, meals: Array.from({ length: 4 }, (_, index) => ({ recipeId: `${index}`, servings: 2, selection: EMPTY_SHOPPING_SELECTION })) }]) assert.equal(isMealPlan(value), false);
});
