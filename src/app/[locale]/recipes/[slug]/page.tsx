import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { RecipeDetail } from "@/components/RecipeDetail";
import { SiteFooter, SiteHeader } from "@/components/SiteHeader";
import { getRecipeHref, type Locale } from "@/lib/recipes";
import { publicRecipe, publicRecipes } from '@/server/public/recipes';
import { JsonLd } from '@/components/JsonLd';
import { recipeMetadata, recipeStructuredData } from '@/lib/seo';
import { getRelatedRecipes } from '@/lib/content-hubs';
import { getOptionalCollections, optionalCollectionDefinitions } from '@/server/public/collections';
import { resolveCollection } from '@/lib/collections';

type RouteParams = { locale: string; slug: string };
type PageProps = { params: Promise<RouteParams>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = 'force-dynamic';

function validLocale(value: string): value is Locale { return value === "pl" || value === "en"; }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!validLocale(locale)) return {};
  const recipe = await publicRecipe(slug, locale);
  if (!recipe) return {};
  return recipeMetadata(recipe, locale);
}

export default async function RecipePage({ params, searchParams }: PageProps) {
  const { locale, slug } = await params;
  if (!validLocale(locale)) notFound();
  const recipe = await publicRecipe(slug, locale);
  if (!recipe) notFound();
  if (slug !== recipe.slug[locale]) permanentRedirect(getRecipeHref(recipe, locale));
  const recipes = await publicRecipes();
  const relatedRecipes = getRelatedRecipes(recipe, recipes);
  const collections = (await getOptionalCollections(recipes, locale)).filter(collection => collection.recipes.some(item => item.id === recipe.id)).map(collection => ({ path: collection.path, title: collection.title[locale] }));
  const contextId = (await searchParams).collection;
  const definition = typeof contextId === 'string' ? (await optionalCollectionDefinitions()).find(item => item.id === contextId) : undefined;
  const resolvedContext = definition ? resolveCollection(definition, recipes, locale) : null;
  const context = resolvedContext?.recipes.some(item => item.id === recipe.id) ? resolvedContext : null;
  const collectionContext = context ? { id: context.id, path: context.path, title: context.title[locale] } : undefined;
  const alternateHref = `${getRecipeHref(recipe, locale === 'pl' ? 'en' : 'pl')}${context ? `?${new URLSearchParams({ collection: context.id })}` : ''}`;
  return <>
    <JsonLd data={recipeStructuredData(recipe, locale)} />
    <SiteHeader locale={locale} alternateHref={alternateHref} />
    <RecipeDetail recipe={recipe} locale={locale} relatedRecipes={relatedRecipes} collections={collections} collectionContext={collectionContext} />
    <SiteFooter locale={locale} />
  </>;
}
