import 'server-only';
import type { Ingredient } from '@/lib/recipes';
import { unrecognisedRecipeIngredientNames, type VerifiedIngredientDictionary } from '@/lib/recipe-diet';
import { lookupExactAliases } from './ingredient-dictionary-store';

/** A lookup grants no new evidence and never submits paid work. Old recipes
 * whose names are already recognised do not depend on the dictionary table. */
export async function getRecipeVerifiedAliases(
  ingredients: readonly Ingredient[],
  db?: Parameters<typeof lookupExactAliases>[1],
  recipeId?: string,
): Promise<VerifiedIngredientDictionary> {
  const names = unrecognisedRecipeIngredientNames(ingredients);
  const aliases = names.length ? await lookupExactAliases(names, db) : new Map();
  if (!recipeId) return aliases;
  const { recipeReviewedAliases } = await import('./recipe-checkpoint');
  return recipeReviewedAliases(recipeId, ingredients, aliases, db);
}
