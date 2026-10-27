import { buildRecipeShopping, combineShoppingLines, EMPTY_SHOPPING_SELECTION, isShoppingSelection, type ShoppingSelection } from './shopping';
import type { PublicRecipe } from './recipe-presentation';

export const MEAL_PLAN_STORAGE_KEY = 'jesie:meal-plan:v1';
export const MAX_PLAN_MEALS = 3;
export type PlannedMeal = { recipeId: string; servings: number; selection: ShoppingSelection };
export type MealPlan = { meals: PlannedMeal[]; checked: string[]; includeOwnedProductIds: string[] };
export const EMPTY_MEAL_PLAN: MealPlan = { meals: [], checked: [], includeOwnedProductIds: [] };

export function isMealPlan(value: unknown): value is MealPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Partial<MealPlan>;
  return Array.isArray(plan.meals) && plan.meals.length <= MAX_PLAN_MEALS
    && new Set(plan.meals.map(meal => meal?.recipeId)).size === plan.meals.length
    && plan.meals.every(meal => meal && typeof meal.recipeId === 'string' && meal.recipeId.length > 0 && meal.recipeId.length <= 100 && Number.isInteger(meal.servings) && meal.servings >= 1 && meal.servings <= 24 && isShoppingSelection(meal.selection))
    && Array.isArray(plan.checked) && plan.checked.length <= 600 && plan.checked.every(id => typeof id === 'string' && id.length <= 3000)
    && Array.isArray(plan.includeOwnedProductIds) && plan.includeOwnedProductIds.length <= 300 && plan.includeOwnedProductIds.every(id => typeof id === 'string' && id.length <= 600);
}

export function addPlannedMeal(plan: MealPlan, recipeId: string, servings: number, selection: ShoppingSelection = EMPTY_SHOPPING_SELECTION): MealPlan {
  if (!Number.isInteger(servings) || servings < 1 || servings > 24) return plan;
  const exists = plan.meals.some(meal => meal.recipeId === recipeId);
  if (!exists && plan.meals.length >= MAX_PLAN_MEALS) return plan;
  const meal = { recipeId, servings, selection: structuredClone(selection) };
  return { ...plan, meals: exists ? plan.meals.map(previous => previous.recipeId === recipeId ? meal : previous) : [...plan.meals, meal] };
}

/** Catalog additions never replace a meal's saved portions or shopping choices. */
export function addMealIfAbsent(plan: MealPlan, recipeId: string, servings: number): MealPlan {
  if (plan.meals.some(meal => meal.recipeId === recipeId)) return plan;
  return addPlannedMeal(plan, recipeId, servings);
}

export function removePlannedMeal(plan: MealPlan, recipeId: string): MealPlan {
  return { ...plan, meals: plan.meals.filter(meal => meal.recipeId !== recipeId) };
}

export function buildMealPlanShopping(plan: MealPlan, recipes: PublicRecipe[], ownedIds: string[]) {
  const catalog = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const unavailable = plan.meals.filter(meal => !catalog.has(meal.recipeId));
  const lines = plan.meals.flatMap(meal => {
    const recipe = catalog.get(meal.recipeId);
    return recipe ? buildRecipeShopping(recipe, meal.servings, ownedIds, { ...meal.selection,
      includeOwnedProductIds: [...new Set([...meal.selection.includeOwnedProductIds, ...plan.includeOwnedProductIds])] }) : [];
  });
  return { buy: combineShoppingLines(lines.filter(line => line.included)),
    owned: combineShoppingLines(lines.filter(line => line.active && line.owned && !line.included)), unavailable };
}
