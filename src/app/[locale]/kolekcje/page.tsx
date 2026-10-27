import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteHeader';
import { CollectionCards } from '@/components/CollectionPageView';
import { getPublicCollections } from '@/server/public/collections';
import { pageMetadata } from '@/lib/seo';
import { publicRecipes } from '@/server/public/recipes';
import type { Locale } from '@/lib/recipes';
import { isLegacyCollection, selectPromotedCollection } from '@/lib/collections';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const published = await getPublicCollections(await publicRecipes(), locale);
  const metadata = pageMetadata({ locale, title: locale === 'pl' ? 'Kolekcje przepisów' : 'Recipe collections', description: locale === 'pl' ? 'Przepisy na wyjątkowe okazje i na co dzień. Wybierz dania, dopasuj porcje i przygotuj wspólną listę zakupów.' : 'Recipes for special occasions and everyday cooking. Choose dishes, adjust servings and prepare one shopping list.', path: `/${locale}/kolekcje`, languages: { pl: '/pl/kolekcje', 'en-GB': '/en/kolekcje' } });
  return published.length ? metadata : { ...metadata, robots: { index: false, follow: true } };
}
export default async function CollectionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'pl' && locale !== 'en') notFound();
  const published = await getPublicCollections(await publicRecipes(), locale);
  const promoted = selectPromotedCollection(published);
  const sorted = [...published].sort((first, second) => Number(second.id === promoted?.id) - Number(first.id === promoted?.id) || first.title[locale].localeCompare(second.title[locale], locale));
  const occasions = sorted.filter(item => !isLegacyCollection(item.id));
  const everyday = sorted.filter(item => isLegacyCollection(item.id));
  return <><SiteHeader locale={locale} alternateHref={`/${locale === 'pl' ? 'en' : 'pl'}/kolekcje`} /><main id="main" className="hub-page page-width"><header className="hub-heading"><p className="eyebrow">{locale === 'pl' ? 'NA WYJĄTKOWE OKAZJE I NA CO DZIEŃ' : 'FOR SPECIAL OCCASIONS AND EVERY DAY'}</p><h1>{locale === 'pl' ? 'Kolekcje przepisów' : 'Recipe collections'}</h1><p>{locale === 'pl' ? 'Wracaj do ulubionych okazji przez cały rok. Wybierz przepisy, ułóż swój zestaw i przygotuj wspólną listę zakupów.' : 'Return to your favourite occasions all year. Choose recipes, create your selection and prepare one shopping list.'}</p></header>
    {promoted && <p className="collection-index-featured">{locale === 'pl' ? 'Teraz polecamy: ' : 'Featured now: '}<Link href={promoted.path}>{promoted.title[locale]} →</Link></p>}
    {occasions.length > 0 && <section className="collection-index-section" aria-labelledby="occasion-collections"><h2 id="occasion-collections">{locale === 'pl' ? 'Na okazje' : 'For special occasions'}</h2><CollectionCards collections={occasions} locale={locale} /></section>}
    {everyday.length > 0 && <section className="collection-index-section" aria-labelledby="everyday-collections"><h2 id="everyday-collections">{locale === 'pl' ? 'Na co dzień' : 'For every day'}</h2><CollectionCards collections={everyday} locale={locale} /></section>}
    {!published.length && <p>{locale === 'pl' ? 'Nowe kolekcje są w przygotowaniu. Tymczasem wybierz danie z pełnego katalogu.' : 'New collections are being prepared. For now, choose a dish from the full catalogue.'}</p>}<p className="collection-all-recipes"><Link href={`/${locale}#recipes`}>{locale === 'pl' ? 'Wszystkie przepisy →' : 'All recipes →'}</Link></p></main><SiteFooter locale={locale} /></>;
}
