import type { Ingredient } from './recipes';
import type { MediaTile } from './recipe-media';
import { ingredientPhotoIdentity, lemonPhotoPolicyIssues } from './citrus-photo-policy';
import { ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity, type IngredientPhotoSubject } from './ingredient-photo-identity';
import { reviewedIncompatibleIngredientPhotoSources, reviewedIngredientPhotoIdentities } from './ingredient-photo-reviews';
import { knownStaticIngredientPhotoIdentity } from './static-ingredient-photos';

export type IngredientPhotoIssue = { ingredientId: string; message: string };
export type IngredientPhotoSources = ReadonlyMap<string, IngredientPhotoSubject>;

/** Compare the actual captured/reviewed subject, never the editable image alt. */
export function ingredientPhotoPolicyIssues(
  ingredients: readonly Ingredient[], photos: Readonly<Record<string, MediaTile>>, knownSources: IngredientPhotoSources = new Map(),
): IngredientPhotoIssue[] {
  const issues: IngredientPhotoIssue[] = [...lemonPhotoPolicyIssues(ingredients, photos)];
  const seen = new Map<string, { ingredient: Ingredient; identity: ReturnType<typeof ingredientPhotoSemanticIdentity> }[]>();
  for (const ingredient of ingredients) {
    const photo = photos[ingredient.id];
    if (!photo) continue;
    const key = ingredientPhotoIdentity(photo);
    const identity = ingredientPhotoSemanticIdentity(ingredient);
    const captured = knownSources.get(key);
    const actual = reviewedIngredientPhotoIdentities.get(photo.src) ?? knownStaticIngredientPhotoIdentity(photo) ?? (captured && ingredientPhotoSemanticIdentity(captured));
    if (reviewedIncompatibleIngredientPhotoSources.has(photo.src)) {
      issues.push({ ingredientId: ingredient.id, message: 'To zdjęcie zostało wycofane po sprawdzeniu: przedstawia niewłaściwy produkt lub jego postać. Wybierz poprawną fotografię.' });
    } else if (actual && !ingredientPhotoIdentitiesCompatible(actual, identity)) {
      issues.push({ ingredientId: ingredient.id, message: 'Zdjęcie przedstawia inny produkt lub inną postać składnika. Wybierz fotografię zgodną ze składnikiem i jego przygotowaniem.' });
    }
    const prior = seen.get(key) ?? [];
    for (const other of prior) {
      // An unspecified solid ingredient can use an illustration of its cut form.
      // Contradictory products/material forms cannot share one identical crop.
      if (ingredientPhotoIdentitiesCompatible(other.identity, identity) || ingredientPhotoIdentitiesCompatible(identity, other.identity)) continue;
      const message = 'Różne produkty lub sprzeczne postaci składników nie mogą korzystać z tego samego zdjęcia i kadru.';
      issues.push({ ingredientId: ingredient.id, message }, { ingredientId: other.ingredient.id, message });
    }
    seen.set(key, [...prior, { ingredient, identity }]);
  }
  return issues.filter((issue, index) => issues.findIndex(other => other.ingredientId === issue.ingredientId && other.message === issue.message) === index);
}
