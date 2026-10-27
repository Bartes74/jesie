import { HomeHeroImage } from '@/components/HomeHeroImage';
import { Suspense } from "react";
import { ArrowDown, ArrowUpRight, Leaf } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/SiteHeader";
import { RecipeCatalog } from "@/components/RecipeCatalog";
import { MyKitchen } from "@/components/MyKitchen";
import { KitchenPlanner } from "@/components/KitchenPlanner";
import { getRecipeHref, type Locale } from "@/lib/recipes";
import { publicRecipes } from '@/server/public/recipes';
import { latestPublishedRecipe } from '@/lib/recipe-presentation';
import type { Metadata } from "next";
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { ContentHubLinks } from '@/components/ContentHubLinks';
import { RecipeDietBadge } from '@/components/RecipeDietBadge';
import { getRecipeImageVariants } from '@/lib/recipe-image-variants';
import { homeStructuredData, pageMetadata } from '@/lib/seo';
import { getOptionalCollections } from '@/server/public/collections';
import { nextCollectionMidnight, selectPromotedCollection } from '@/lib/collections';
import { CollectionHeroPromotion } from '@/components/CollectionTheme';
import { CollectionPromotionRefresh } from '@/components/CollectionPromotionRefresh';
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const recipes = await publicRecipes();
  const featured = latestPublishedRecipe(recipes);
  const promoted = selectPromotedCollection(await getOptionalCollections(recipes, locale));
  const metadata = pageMetadata({
    locale,
    title: locale === 'pl' ? 'jesie.pl — dobre jedzenie na co dzień' : 'jesie.pl — good food every day',
    description: locale === 'pl' ? 'Znajdź pomysł na codzienny posiłek z dostępnych składników. Przelicz porcje i gotuj krok po kroku z jesie.pl.' : 'Find an everyday meal using the ingredients you have. Adjust portions and cook step by step with jesie.pl.',
    path: `/${locale}`,
    languages: { pl: '/pl', 'en-GB': '/en' },
    ...(promoted?.theme ? { image: { url: promoted.theme.hero.src, width: promoted.theme.hero.width, height: promoted.theme.hero.height, alt: promoted.theme.hero.alt[locale] } } : featured ? { image: { ...getRecipeImageVariants(featured).social, alt: featured.imageAlt[locale] } } : {}),
  });
  const filters = await searchParams;
  if (['q', 'category', 'diet', 'time', 'difficulty', 'saved', 'pantry', 'sort', 'collection'].some(key => filters[key])) {
    metadata.robots = { ...(typeof metadata.robots === 'object' ? metadata.robots : {}), index: false };
  }
  return { ...metadata, alternates: { ...metadata.alternates, types: { 'application/rss+xml': `/${locale}/feed.xml` } } };
}

export default async function Home({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const pl = locale === "pl";
  const recipes = await publicRecipes();
  const featured = latestPublishedRecipe(recipes);
  const collections = await getOptionalCollections(recipes, locale);
  const promoted = selectPromotedCollection(collections);
  return <>
    <CollectionPromotionRefresh nextBoundary={nextCollectionMidnight(new Date()).getTime()} />
    <JsonLd data={homeStructuredData(locale, featured, promoted?.theme ? { url: promoted.theme.hero.src, width: promoted.theme.hero.width, height: promoted.theme.hero.height } : undefined)} />
    <SiteHeader locale={locale} />
    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="tiny-line" />{pl ? "PROSTO. SEZONOWO. Z APETYTEM." : "SIMPLE. SEASONAL. FULL OF FLAVOUR."}</p>
          <h1 id="hero-title">{pl ? <>Dobre jedzenie.<br />Na co <span className="highlight-word">dzień.</span></> : <>Good food.<br />Every <span className="highlight-word">day.</span></>}</h1>
          <p className="hero-description">{pl ? <>Przepisy, do których chce się wracać.<br />Wybierz coś dla siebie i gotuj po swojemu.</> : <>Recipes you’ll want to come back to.<br />Find your favourite and make it your own.</>}</p>
          <a className="primary-button" href="#recipes">{pl ? "Znajdź swój przepis" : "Find your next recipe"}<ArrowUpRight size={23} strokeWidth={1.5} aria-hidden="true" /></a>
          <p className="hero-footnote"><Leaf size={15} aria-hidden="true" />{pl ? "Małe kroki. Dobry smak." : "Small steps. Great flavours."}</p>
        </div>
        <div className="hero-visual">
          {promoted ? <CollectionHeroPromotion collection={promoted} locale={locale} /> : <><div className="hero-circle" />
          {featured && <HomeHeroImage src={featured.image} alt={featured.imageAlt[locale]} />}
          <svg className="hero-squiggle" viewBox="0 0 190 90" aria-hidden="true"><path d="M2 60 C80 9 92 11 80 45 S78 100 185 2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          <span className="hero-strokes" aria-hidden="true"><i /><i /></span>
          {featured && <a href={getRecipeHref(featured, locale)} className="hero-caption"><span>{pl ? "Najnowszy przepis" : "Latest recipe"}</span><strong><span className="recipe-diet-title"><RecipeDietBadge recipe={featured} locale={locale} />{featured.title[locale]}</span><ArrowUpRight size={17} aria-hidden="true" /></strong></a>}</>}
        </div>
      </section>
      <MyKitchen recipes={recipes} locale={locale} />
      <section id="recipes" className="catalog-section page-width" aria-labelledby="catalog-title">
        <div className="catalog-heading"><p className="eyebrow">{pl ? "TWOJA CODZIENNA INSPIRACJA" : "YOUR EVERYDAY INSPIRATION"}</p><h2 id="catalog-title">{pl ? "Co dziś ugotujesz?" : "What’s cooking today?"}</h2><ArrowDown size={22} strokeWidth={1.3} aria-hidden="true" /></div>
        <Suspense fallback={<p className="catalog-loading">{pl ? "Wczytywanie przepisów…" : "Loading recipes…"}</p>}><RecipeCatalog locale={locale} recipes={recipes} /></Suspense>
      </section>
      <KitchenPlanner recipes={recipes} locale={locale} />
      <ContentHubLinks locale={locale} recipes={recipes} publishedCollections={collections} />
      <section className="closing-note page-width"><div className="closing-icon"><CookingIllustration /></div><div><p className="eyebrow">{pl ? "GOTOWANIE PO TWOJEMU" : "MAKE IT YOUR OWN"}</p><h2>{pl ? "Dopasuj przepis do swojego dnia." : "A recipe that fits your day."}</h2><p>{pl ? "Zmień liczbę porcji, odhaczaj składniki i zabierz przepis do kuchni — na telefonie albo na papierze." : "Adjust the portions, tick off ingredients and take the recipe into your kitchen — on your phone or on paper."}</p></div></section>
    </main><SiteFooter locale={locale} />
  </>;
}
function CookingIllustration() { return <svg width="94" height="94" viewBox="0 0 94 94" fill="none" aria-hidden="true"><path d="M24 45h48l-4 28c-1 6-7 8-20 8s-19-2-20-8l-4-28ZM20 45h56M31 40c0-5 3-8 9-8h17c6 0 9 3 9 8M17 52h7m48 0h7M38 24c-9-10 3-13 0-21m12 21c-9-10 3-13 0-21m12 21c-9-10 3-13 0-21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>; }
