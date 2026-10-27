import type { EditorialContent } from '@/lib/editorial-types';
import type { LibraryTarget } from '@/lib/media-library';
import type { MediaTile } from '@/lib/recipe-media';
import { capturedIngredientStyleProfile, ingredientImageIdentity } from '@/server/ai/ingredient-profile';
import { ingredientPhotosCompatible } from '@/lib/ingredient-photo-identity';
import { reviewedIngredientPhotoCompatible, reviewedIncompatibleIngredientPhotoSources } from '@/lib/ingredient-photo-reviews';
import { compatibleRecipePhotoSource, isReviewedWrongStepPhoto, recipePhotoSource } from '@/lib/recipe-photo-evidence';
import { samePhotoSubject } from '@/server/ai/photo-subject';

export function validLibraryTarget(target: LibraryTarget, content: EditorialContent) {
  if (target.recipeId !== content.recipe.id) return false;
  if (target.kind === 'hero') return target.targetId === undefined;
  if (!target.targetId) return false;
  return target.kind === 'ingredient' ? content.recipe.ingredients.some(item => item.id === target.targetId)
    : content.recipe.steps.some(item => item.id === target.targetId);
}

export function libraryImageCompatible(source: { kind: 'hero' | 'ingredient' | 'step'; recipeId: string; targetId: string | null; input: EditorialContent; ingredientKey?: string; src?: string }, current: EditorialContent, target: LibraryTarget) {
  if (!validLibraryTarget(target, current) || source.kind !== target.kind) return false;
  if (target.kind === 'ingredient') {
    if(source.src&&reviewedIncompatibleIngredientPhotoSources.has(source.src))return false;
    const ingredient = current.recipe.ingredients.find(item => item.id === target.targetId)!;
    const captured = source.input.recipe.ingredients.find(item => item.id === source.targetId);
    return Boolean(captured && (source.src?reviewedIngredientPhotoCompatible(source.src,captured,ingredient):ingredientPhotosCompatible(captured, ingredient))
      && source.ingredientKey === ingredientImageIdentity(ingredient, capturedIngredientStyleProfile(current)).key);
  }
  if (source.kind === 'ingredient') return false;
  if (source.kind === 'step' && source.src && isReviewedWrongStepPhoto({ src: source.src, columns: 1, rows: 1, index: 0 })) return false;
  const evidence = recipePhotoSource(source.input.recipe, source.kind, source.targetId, source.src ?? '');
  return source.recipeId === source.input.recipe.id && Boolean(evidence
    && compatibleRecipePhotoSource(evidence, current.recipe, target.kind, target.targetId ?? null)
    && (source.recipeId !== current.recipe.id || samePhotoSubject(source.input, current, target.kind, target.targetId ?? null)));
}

/** Atlas files contain multiple independent images; the source URL alone is not a usage reference. */
export function libraryPhotoIdentity(photo: MediaTile) {
  return `${photo.src}:${photo.columns}:${photo.rows}:${photo.index}`;
}
