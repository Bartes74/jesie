import type { PublicRecipe } from './recipe-presentation';
import { getRecipeHref, type Locale } from './recipes';
import { buildRecipeShopping, combineShoppingLines, EMPTY_SHOPPING_SELECTION, isShoppingSelection, type ShoppingSelection } from './shopping';

export type CollectionSelectedRecipe = { recipeId: string; servings: number; selection: ShoppingSelection };
export type CollectionSelection = { recipes: CollectionSelectedRecipe[]; checked: string[] };
export const EMPTY_COLLECTION_SELECTION: CollectionSelection = { recipes: [], checked: [] };
export const collectionSelectionKey = (collectionId: string) => `jesie:collection-selection:v1:${collectionId}`;

export function isCollectionSelection(value: unknown): value is CollectionSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<CollectionSelection>;
  return Array.isArray(state.recipes) && state.recipes.length <= 5000
    && state.recipes.every(item => item && typeof item.recipeId === 'string' && item.recipeId.length > 0 && item.recipeId.length <= 100 && Number.isInteger(item.servings) && item.servings >= 1 && item.servings <= 24 && isShoppingSelection(item.selection))
    && new Set(state.recipes.map(item => item.recipeId)).size === state.recipes.length
    && Array.isArray(state.checked) && state.checked.length <= 10000 && state.checked.every(id => typeof id === 'string' && id.length <= 3000);
}

/** Collection selections are independent of the everyday three-meal plan. */
export function selectCollectionRecipe(state: CollectionSelection, recipeId: string, servings: number, selection: ShoppingSelection = EMPTY_SHOPPING_SELECTION): CollectionSelection {
  if (!recipeId || recipeId.length > 100 || !Number.isInteger(servings) || servings < 1 || servings > 24 || !isShoppingSelection(selection)) return state;
  const item = { recipeId, servings, selection: structuredClone(selection) };
  if (state.recipes.some(previous => previous.recipeId === recipeId)) return { ...state, recipes: state.recipes.map(previous => previous.recipeId === recipeId ? item : previous) };
  if (state.recipes.length >= 5000) return state;
  return { ...state, recipes: [...state.recipes, item] };
}

export function removeCollectionRecipe(state: CollectionSelection, recipeId: string): CollectionSelection {
  return { ...state, recipes: state.recipes.filter(item => item.recipeId !== recipeId) };
}

export function buildCollectionShopping(state: CollectionSelection, recipes: readonly PublicRecipe[]) {
  const available = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const unavailable = state.recipes.filter(item => !available.has(item.recipeId));
  const lines = state.recipes.flatMap(item => {
    const recipe = available.get(item.recipeId);
    // The event list includes all required ingredients. Existing fridge stock is not silently deducted.
    return recipe ? buildRecipeShopping(recipe, item.servings, [], item.selection).filter(line => line.included) : [];
  });
  return { items: combineShoppingLines(lines), unavailable };
}

export function collectionRecipeHref(recipe: PublicRecipe, locale: Locale, collectionId: string) {
  return `${getRecipeHref(recipe, locale)}?${new URLSearchParams({ collection: collectionId })}`;
}
