import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { KitchenPlanner } from '@/components/KitchenPlanner';
import { RecipeCatalog } from '@/components/RecipeCatalog';
import { publicRecipes } from '@/server/public/recipes';
import { pageMetadata } from '@/lib/seo';
import type { Locale } from '@/lib/recipes';
import { optionalCollectionDefinitions } from '@/server/public/collections';
import { resolveCollection } from '@/lib/collections';
import { CollectionSetLinks } from '@/components/CollectionSetLinks';

export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  return { ...pageMetadata({ locale, title: locale === 'pl' ? 'Plan i zakupy' : 'Meal plan and shopping', description: locale === 'pl' ? 'Wybierz do trzech dań, ustaw porcje i przygotuj wspólną listę zakupów.' : 'Choose up to three meals, set servings and prepare one shopping list.', path: `/${locale}/plan`, languages: { pl: '/pl/plan', 'en-GB': '/en/plan' } }), robots: { index: false, follow: true } };
}

export default async function PlanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const recipes = await publicRecipes();
  const collections = (await optionalCollectionDefinitions()).map(item => resolveCollection(item, recipes, locale));
  const pl = locale === 'pl';
  return <><SiteHeader locale={locale} alternateHref={`/${pl ? 'en' : 'pl'}/plan`} /><main id="main" className="plan-page">
    <header className="plan-page-heading page-width"><p className="eyebrow">{pl ? 'OD POMYSŁU DO ZAKUPÓW' : 'FROM IDEAS TO SHOPPING'}</p><h1>{pl ? 'Plan i zakupy' : 'Meal plan and shopping'}</h1><p>{pl ? 'Wybierz danie → ustaw porcje → dodaj do planu. Wszystkie wybrane posiłki i zakupy znajdziesz tutaj.' : 'Choose a recipe → set servings → add it to your plan. Find all your chosen meals and shopping here.'}</p></header>
    <KitchenPlanner recipes={recipes} locale={locale} />
    <CollectionSetLinks collections={collections.map(item => ({ id: item.id, path: item.path, title: item.title[locale] }))} locale={locale} />
    <section id="recipes" className="catalog-section page-width plan-picker" aria-labelledby="catalog-title"><div className="catalog-heading"><p className="eyebrow">{pl ? 'WYBIERZ DANIA DO SWOJEGO PLANU' : 'CHOOSE MEALS FOR YOUR PLAN'}</p><h2 id="catalog-title">{pl ? 'Co dodasz do planu?' : 'What will you add to your plan?'}</h2></div><Suspense fallback={<p>{pl ? 'Wczytuję przepisy…' : 'Loading recipes…'}</p>}><RecipeCatalog recipes={recipes} locale={locale} mode="plan" /></Suspense></section>
  </main><SiteFooter locale={locale} /></>;
}
