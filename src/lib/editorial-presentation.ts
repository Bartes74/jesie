import type { RecipeSummary } from './editorial-types';

export type RecipeListFilter = 'all' | 'draft' | 'published' | 'archived' | 'deleted';

export function isActiveRecipe(recipe: RecipeSummary): boolean {
  return !recipe.deletedAt && recipe.editorialStatus !== 'archived';
}

/** A never-published, accepted recipe is still a draft awaiting publication. */
export function isRecipeDraft(recipe: RecipeSummary): boolean {
  return isActiveRecipe(recipe) && (recipe.publicationStatus !== 'published' || recipe.hasUnpublishedChanges);
}

export function matchesRecipeFilter(recipe: RecipeSummary, filter: RecipeListFilter): boolean {
  if (filter === 'deleted') return Boolean(recipe.deletedAt);
  if (recipe.deletedAt) return false;
  if (filter === 'archived') return recipe.editorialStatus === 'archived';
  if (!isActiveRecipe(recipe)) return false;
  if (filter === 'draft') return isRecipeDraft(recipe);
  if (filter === 'published') return recipe.publicationStatus === 'published';
  return true;
}

export function recipeListStatus(recipe: RecipeSummary): string {
  if (recipe.deletedAt) return 'Kosz';
  if (recipe.editorialStatus === 'archived') return 'Archiwum';
  if (recipe.publicationStatus === 'published') return recipe.hasUnpublishedChanges ? 'Zmiany w szkicu' : 'Opublikowany';
  if (!recipe.languages.pl || !recipe.languages.en) return 'Uzupełnij treść';
  if (!recipe.image) return 'Sprawdź treść i dodaj zdjęcia';
  if (recipe.editorialStatus === 'approved') return 'Gotowy do publikacji';
  return 'Sprawdź przepis';
}

export function recipeListCounts(recipes: RecipeSummary[]) {
  return {
    active: recipes.filter(isActiveRecipe).length,
    drafts: recipes.filter(isRecipeDraft).length,
    published: recipes.filter(recipe => isActiveRecipe(recipe) && recipe.publicationStatus === 'published').length,
  };
}
