import { buildIngredientCatalog, ingredientProductIds, type IngredientProduct } from './ingredient-catalog';
import { isCookingByproduct, isOptionalIngredient, pantryProductWeight } from './pantry';
import type { PublicRecipe } from './recipe-presentation';
import type { PlannedMeal } from './meal-plan';
import { buildRecipeShopping } from './shopping';

export type PlanRecipeRecommendation = { recipe: PublicRecipe; sharedProducts: IngredientProduct[] };
function mainProductIds(recipe: PublicRecipe): string[] {
  return [...new Set(recipe.ingredients.filter(ingredient => !isOptionalIngredient(ingredient) && !isCookingByproduct(ingredient))
    .flatMap(ingredientProductIds).filter(id => pantryProductWeight(id) === 1))];
}

/** Reuse main ingredients already in a one- or two-meal plan; seasonings never drive a suggestion. */
export function recommendPlanRecipes(recipes: PublicRecipe[], meals: PlannedMeal[], limit = 3): PlanRecipeRecommendation[] {
  const planned = new Set(meals.map(meal => meal.recipeId));
  if (planned.size < 1 || planned.size > 2) return [];
  const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const productsInPlan = new Set(meals.flatMap(meal => {
    const recipe = byId.get(meal.recipeId);
    return recipe ? buildRecipeShopping(recipe, meal.servings, [], meal.selection)
      .filter(line => line.active && pantryProductWeight(line.productId) === 1).map(line => line.productId) : [];
  }));
  if (!productsInPlan.size) return [];
  const catalog = new Map(buildIngredientCatalog(recipes).map(product => [product.id, product]));
  return recipes.filter(recipe => !planned.has(recipe.id)).flatMap(recipe => {
    const sharedProducts = mainProductIds(recipe).filter(id => productsInPlan.has(id)).sort().flatMap(id => catalog.get(id) ?? []);
    return sharedProducts.length ? [{ recipe, sharedProducts }] : [];
  }).sort((left, right) => right.sharedProducts.length - left.sharedProducts.length || left.recipe.times.total - right.recipe.times.total || left.recipe.id.localeCompare(right.recipe.id))
    .slice(0, Number.isFinite(limit) ? Math.min(3, Math.max(0, Math.floor(limit))) : 3);
}
