import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CollectionPageView } from '@/components/CollectionPageView';
import { JsonLd } from '@/components/JsonLd';
import { getRecipeHref, type Locale } from '@/lib/recipes';
import { absoluteUrl, pageMetadata } from '@/lib/seo';
import { getRecipeImageVariants } from '@/lib/recipe-image-variants';
import { publicRecipes } from '@/server/public/recipes';
import { getPublicCollection, getPublicCollections } from '@/server/public/collections';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
async function collectionFor(params: Props['params']) {
  const { locale, slug } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const recipes = await publicRecipes();
  const collection = await getPublicCollection(slug, recipes, locale);
  if (!collection) notFound();
  return { locale: locale as Locale, collection, recipes };
}
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, collection } = await collectionFor(params);
  const hero = collection.theme?.hero;
  const recipe = collection.recipes[0];
  const image = hero ? { url: hero.src, width: hero.width, height: hero.height, alt: hero.alt[locale] } : recipe ? { ...getRecipeImageVariants(recipe).social, alt: recipe.imageAlt[locale] } : undefined;
  const metadata = pageMetadata({ locale, title: collection.title[locale], description: collection.description[locale], path: collection.path, languages: { pl: `/pl/kolekcje/${collection.slug.pl}`, 'en-GB': `/en/kolekcje/${collection.slug.en}` }, ...(image ? { image } : {}) });
  const filters = await searchParams;
  if (!collection.recipes.length || ['q', 'category', 'diet', 'time', 'difficulty', 'sort', 'saved', 'selected'].some(key => filters[key])) metadata.robots = { index: false, follow: true };
  return metadata;
}
export default async function CollectionPage({ params }: Props) {
  const { locale, collection, recipes } = await collectionFor(params);
  const related = (await getPublicCollections(recipes, locale)).filter(item => item.id !== collection.id);
  const url = absoluteUrl(collection.path);
  return <><CollectionPageView collection={collection} locale={locale} related={related} /><JsonLd data={{ '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': `${url}#webpage`, url, name: collection.title[locale], description: collection.description[locale], inLanguage: locale === 'pl' ? 'pl' : 'en-GB', ...(collection.dateModified ? { dateModified: collection.dateModified } : {}), mainEntity: { '@id': `${url}#list` } },
    { '@type': 'ItemList', '@id': `${url}#list`, itemListElement: collection.recipes.map((recipe, index) => ({ '@type': 'ListItem', position: index + 1, url: absoluteUrl(getRecipeHref(recipe, locale)) })) },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'jesie.pl', item: absoluteUrl(`/${locale}`) }, { '@type': 'ListItem', position: 2, name: locale === 'pl' ? 'Kolekcje' : 'Collections', item: absoluteUrl(`/${locale}/kolekcje`) }, { '@type': 'ListItem', position: 3, name: collection.title[locale], item: url }] },
  ] }} /></>;
}
