import type { MediaTile } from './recipe-media';
import type { Localised, Recipe } from './recipes';
import { getRecipeDiet } from './recipe-diet';

/** Cookbook data sent to readers excludes private editorial provenance. */
export type PublicRecipe = Omit<Recipe, 'provenance' | 'heroPresentation'> & { version?: string; kitchenVerified?: boolean };

/** The public accessor supplies active recipes from newest first publication to oldest. */
export function latestPublishedRecipe(recipes: readonly PublicRecipe[]): PublicRecipe | undefined {
  return recipes[0];
}

function imageDescription(text: Localised): Localised {
  const withoutLegacyPrefix = (value: string) => value.replace(/^(?:Ilustracja AI|AI illustration):\s*/i, '');
  return { pl: withoutLegacyPrefix(text.pl), en: withoutLegacyPrefix(text.en) };
}

export function stepPhotoCaption(text: Localised): Localised {
  const caption = imageDescription(text);
  const withoutLegacyPrefix = (value: string) => value.replace(/^\s*(?:Najważniejszy detal|Key visual detail)\s*:\s*/i, '');
  return { pl: withoutLegacyPrefix(caption.pl), en: withoutLegacyPrefix(caption.en) };
}

function photoPresentation(photo: MediaTile, captionPresentation: (text: Localised) => Localised): MediaTile {
  return {
    ...photo,
    alt: imageDescription(photo.alt),
    ...(photo.caption ? { caption: captionPresentation(photo.caption) } : {}),
  };
}

function photoCollection(photos: Record<string, MediaTile>, captionPresentation = imageDescription): Record<string, MediaTile> {
  return Object.fromEntries(Object.entries(photos).map(([id, photo]) => [id, photoPresentation(photo, captionPresentation)]));
}

/** Project saved snapshots for display without modifying their editorial history. */
export function toPublicRecipe(recipe: Recipe & { version?: string; kitchenVerified?: boolean }): PublicRecipe {
  const { provenance, heroPresentation, ...presentation } = recipe;
  // The omitted value stays private even when the rest is serialized into client props.
  void provenance;
  void heroPresentation;

  const scalingNote = recipe.scalingNote ? {
    pl: recipe.scalingNote.pl.replace('; przepis demonstracyjny nie ma sprawdzonych wariantów form.', '.'),
    en: recipe.scalingNote.en.replace('; this demonstration recipe has no kitchen-tested tin variations.', '.'),
  } : recipe.scalingNote;

  return {
    ...presentation,
    diet: getRecipeDiet(recipe),
    version: recipe.version ?? recipe.publication?.dateModified ?? 'legacy',
    kitchenVerified: recipe.kitchenVerified === true,
    collection: recipe.collection ?? 'author',
    ...(recipe.substitutions ? { substitutions: recipe.substitutions.filter(item => item.status === 'approved' && recipe.ingredients.some(ingredient => ingredient.id === item.ingredientId)) } : {}),
    imageAlt: imageDescription(recipe.imageAlt),
    ...(scalingNote ? { scalingNote } : {}),
    ...(recipe.photos ? { photos: {
      ingredients: photoCollection(recipe.photos.ingredients),
      steps: photoCollection(recipe.photos.steps, stepPhotoCaption),
    } } : {}),
  };
}
