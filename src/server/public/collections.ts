import 'server-only';
import { cache } from 'react';
import { collectionIsDiscoverable, resolveCollection, type CollectionDefinition } from '@/lib/collections';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import { getPublishedCollectionDefinitions } from '@/server/collections/store';
import { withPublicCollectionReadModel } from './read-model';
import { isDatabaseUnavailable } from '@/server/http/database-failure';
import { isNeonQuotaError } from './published-snapshot';

export const publicCollectionDefinitions = cache(async (): Promise<CollectionDefinition[]> => withPublicCollectionReadModel(
  () => getPublishedCollectionDefinitions(), definitions => definitions,
));
export async function optionalCollectionDefinitions() {
  try { return await publicCollectionDefinitions(); }
  catch (error) { if (isDatabaseUnavailable(error) || isNeonQuotaError(error)) return []; throw error; }
}
export async function getPublicCollections(recipes: readonly PublicRecipe[], locale: Locale) {
  return (await publicCollectionDefinitions()).map(definition => resolveCollection(definition, recipes, locale)).filter(collectionIsDiscoverable);
}
/** Optional discovery surfaces can keep serving recipes during an older v1 fallback. */
export async function getOptionalCollections(recipes: readonly PublicRecipe[], locale: Locale) {
  try { return await getPublicCollections(recipes, locale); }
  catch (error) { if (isDatabaseUnavailable(error) || isNeonQuotaError(error)) return []; throw error; }
}
/** A published empty collection keeps its stable public URL; discovery uses the filtered list above. */
export async function getPublicCollection(slug: string, recipes: readonly PublicRecipe[], locale: Locale) {
  const definition = (await publicCollectionDefinitions()).find(collection => collection.slug[locale] === slug);
  return definition ? resolveCollection(definition, recipes, locale) : null;
}
