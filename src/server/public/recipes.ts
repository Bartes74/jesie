import 'server-only';
import { cache } from 'react';
import { getPublishedRecipes, getPublishedRecipe } from '@/server/editorial/store';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import { withPublicReadModel } from './read-model';

export const publicRecipes = cache(async () => withPublicReadModel(
  async () => (await getPublishedRecipes()).map(toPublicRecipe),
  recipes => recipes,
));
export const publicRecipe = cache(async (slug: string, locale: Locale) => withPublicReadModel(
  async () => {
    const recipe = await getPublishedRecipe(slug, locale);
    return recipe ? toPublicRecipe(recipe) : null;
  },
  recipes => recipes.find(recipe => recipe.slug[locale] === slug) ?? null,
));
