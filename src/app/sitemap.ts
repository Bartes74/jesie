import type { MetadataRoute } from 'next';
import { publicRecipes } from '@/server/public/recipes';
import { getGuideHref, guides } from '@/lib/content-hubs';
import { getPublicCollections } from '@/server/public/collections';
import { PUBLIC_LOCALES, absoluteUrl, isProductionIndexable, recipeSitemapEntries } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isProductionIndexable()) return [];
  const recipes = await publicRecipes();
  const collectionLists = { pl: await getPublicCollections(recipes, 'pl'), en: await getPublicCollections(recipes, 'en') };
  const result: MetadataRoute.Sitemap = [...recipeSitemapEntries(recipes)];
  for (const locale of PUBLIC_LOCALES) {
    const dates = [...recipes.map(recipe => recipe.publication?.dateModified), ...guides.map(guide => guide.dateModified)].filter((date): date is string => Boolean(date)).sort((a, b) => Date.parse(a) - Date.parse(b));
    const lastModified = dates.at(-1);
    result.push({ url: absoluteUrl(`/${locale}`), ...(lastModified ? { lastModified } : {}), alternates: { languages: { pl: absoluteUrl('/pl'), 'en-GB': absoluteUrl('/en') } } });
    const publishedCollections = collectionLists[locale];
    for (const path of [...(publishedCollections.length ? ['kolekcje'] : []), 'poradniki', 'o-serwisie']) {
      result.push({ url: absoluteUrl(`/${locale}/${path}`), alternates: { languages: { pl: absoluteUrl(`/pl/${path}`), 'en-GB': absoluteUrl(`/en/${path}`) } } });
    }
    for (const collection of publishedCollections) {
      const equivalents = PUBLIC_LOCALES.flatMap(otherLocale => {
        const equivalent = collectionLists[otherLocale].find(item => item.id === collection.id);
        return equivalent ? [[otherLocale === 'pl' ? 'pl' : 'en-GB', absoluteUrl(equivalent.path)]] : [];
      });
      result.push({ url: absoluteUrl(collection.path), ...(collection.dateModified ? { lastModified: collection.dateModified } : {}), alternates: { languages: Object.fromEntries(equivalents) } });
    }
    for (const guide of guides) {
      result.push({ url: absoluteUrl(getGuideHref(guide, locale)), lastModified: guide.dateModified, alternates: { languages: { pl: absoluteUrl(getGuideHref(guide, 'pl')), 'en-GB': absoluteUrl(getGuideHref(guide, 'en')) } } });
    }
  }
  return result;
}
