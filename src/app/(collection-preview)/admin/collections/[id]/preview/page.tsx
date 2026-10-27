import { notFound } from 'next/navigation';
import { ArrowUpRight, Leaf } from 'lucide-react';
import { pageAdmin } from '@/server/auth-page';
import { getCollection } from '@/server/collections/store';
import { getThemeGeneration } from '@/server/collections/theme-store';
import { getPublishedRecipes } from '@/server/editorial/store';
import { CollectionError } from '@/server/collections/errors';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import { collectionPublicDefinition, resolveCollection, type CollectionTheme } from '@/lib/collections';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { CollectionPageView } from '@/components/CollectionPageView';
import { CollectionHeroPromotion } from '@/components/CollectionTheme';

export const dynamic = 'force-dynamic';
export default async function CollectionPreviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ locale?: string; surface?: string; generation?: string; revision?: string }> }) {
  await pageAdmin();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const locale = query.locale === 'en' ? 'en' : 'pl';
  const record = await getCollection(id).catch(error => { if (error instanceof CollectionError && error.status === 404) notFound(); throw error; });
  if (query.revision && Number(query.revision) !== record.revision) return <main className="page-width hub-page"><h1>Szkic kolekcji zmienił się.</h1><p>Wróć do edytora i wczytaj bieżącą wersję przed oceną podglądu.</p></main>;
  let theme = record.content.theme;
  if (query.generation) { const generation = await getThemeGeneration(id, query.generation).catch(error => { if (error instanceof CollectionError && error.status === 404) notFound(); throw error; }); if (!generation || generation.status !== 'ready' || !generation.theme) notFound(); theme = generation.theme; }
  const previewTheme: CollectionTheme | null = theme ? { ...theme, hero: { ...theme.hero, src: `/api/admin/collections/${encodeURIComponent(id)}/assets/${encodeURIComponent(theme.hero.assetId)}` }, atmosphere: theme.atmosphere ? { ...theme.atmosphere, src: `/api/admin/collections/${encodeURIComponent(id)}/assets/${encodeURIComponent(theme.atmosphere.assetId)}` } : null } : null;
  const recipes = (await getPublishedRecipes()).map(toPublicRecipe);
  const collection = resolveCollection(collectionPublicDefinition(id, { ...record.content, theme: previewTheme }, record.updatedAt), recipes, locale);
  const pl = locale === 'pl';
  const previewHref = (language: string, surface: 'collection' | 'home') => `/admin/collections/${encodeURIComponent(id)}/preview?${new URLSearchParams({ locale: language, surface, revision: String(record.revision), ...(query.generation ? { generation: query.generation } : {}) })}`;
  return <div data-collection-preview={id} data-preview-revision={record.revision} lang={locale}>
    {query.surface === 'home' ? <><SiteHeader locale={locale} alternateHref={previewHref(pl ? 'en' : 'pl', 'home')} /><main id="main"><section className="hero page-width" aria-labelledby="hero-title"><div className="hero-copy"><p className="eyebrow"><span className="tiny-line" />{pl ? 'PROSTO. SEZONOWO. Z APETYTEM.' : 'SIMPLE. SEASONAL. FULL OF FLAVOUR.'}</p><h1 id="hero-title">{pl ? <>Dobre jedzenie.<br />Na co <span className="highlight-word">dzień.</span></> : <>Good food.<br />Every <span className="highlight-word">day.</span></>}</h1><p className="hero-description">{pl ? <>Przepisy, do których chce się wracać.<br />Wybierz coś dla siebie i gotuj po swojemu.</> : <>Recipes you’ll want to come back to.<br />Find your favourite and make it your own.</>}</p><a className="primary-button" href={`/${locale}#recipes`}>{pl ? 'Znajdź swój przepis' : 'Find your next recipe'}<ArrowUpRight size={23} strokeWidth={1.5} aria-hidden="true" /></a><p className="hero-footnote"><Leaf size={15} aria-hidden="true" />{pl ? 'Małe kroki. Dobry smak.' : 'Small steps. Great flavours.'}</p></div><div className="hero-visual"><CollectionHeroPromotion collection={{ ...collection, path: previewHref(locale, 'collection') }} locale={locale} /></div></section></main><SiteFooter locale={locale} /></> : <CollectionPageView collection={collection} locale={locale} alternateHref={previewHref(pl ? 'en' : 'pl', 'collection')} />}
  </div>;
}
