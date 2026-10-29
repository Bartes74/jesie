import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
import type { PublicCollection } from '@/lib/collections';
import type { Locale } from '@/lib/recipes';
import { SiteFooter, SiteHeader } from './SiteHeader';
import { CollectionAccent, CollectionArtwork, CollectionThemeSurface } from './CollectionTheme';
import { CollectionCatalog } from './CollectionCatalog';

export function CollectionCards({ collections, locale }: { collections: PublicCollection[]; locale: Locale }) {
  return <div className="collection-card-grid">{collections.map(collection => <Link href={collection.path} key={collection.id} className="collection-discovery-card">
    {collection.theme && <CollectionThemeSurface theme={collection.theme} className="collection-discovery-art"><CollectionArtwork theme={collection.theme} locale={locale} /></CollectionThemeSurface>}
    <div><span>{collection.recipes.length} {locale === 'pl' ? 'przepisów' : 'recipes'}</span><h2>{collection.title[locale]}<ArrowUpRight size={22} aria-hidden="true" /></h2><p>{collection.description[locale]}</p></div>
  </Link>)}</div>;
}

export function CollectionPageView({ collection, locale, related = [], alternateHref }: { collection: PublicCollection; locale: Locale; related?: PublicCollection[]; alternateHref?: string }) {
  const pl = locale === 'pl';
  const other = pl ? 'en' : 'pl';
  return <CollectionThemeSurface theme={collection.theme}><SiteHeader locale={locale} alternateHref={alternateHref ?? `/${other}/kolekcje/${collection.slug[other]}`} preserveCollectionFilters={!alternateHref} />
    <main id="main" className="collection-page"><div className="page-width collection-breadcrumb"><nav className="content-breadcrumb" aria-label={pl ? 'Ścieżka strony' : 'Breadcrumb'}><Link href={`/${locale}`}>jesie.pl</Link><span aria-hidden="true">/</span><Link href={`/${locale}/kolekcje`}>{pl ? 'Kolekcje' : 'Collections'}</Link><span aria-hidden="true">/</span><span aria-current="page">{collection.title[locale]}</span></nav></div>
      <section className={`collection-hero${collection.theme ? ' has-artwork' : ''}`} aria-labelledby="collection-title"><div className="page-width collection-hero-inner"><div><p className="eyebrow">{pl ? 'KOLEKCJA PRZEPISÓW' : 'RECIPE COLLECTION'}</p><h1 id="collection-title">{collection.title[locale]}</h1><p className="collection-description">{collection.description[locale]}</p><p className="collection-count">{collection.recipes.length} {pl ? 'przepisów na Twój stół' : 'recipes for your table'}</p><a href="#recipes" className="primary-button">{pl ? 'Poznaj przepisy' : 'Explore recipes'}<ArrowDown size={18} aria-hidden="true" /></a></div>{collection.theme && <div className="collection-hero-art"><CollectionArtwork theme={collection.theme} locale={locale} eager /><CollectionAccent theme={collection.theme} slot="corner" /></div>}</div></section>
      <CollectionAccent theme={collection.theme} slot="garland" />
      <div className="collection-catalog-surface"><div className="page-width"><Suspense fallback={<p className="catalog-loading">{pl ? 'Wczytuję kolekcję…' : 'Loading the collection…'}</p>}><CollectionCatalog collectionId={collection.id} title={collection.title[locale]} locale={locale} recipes={collection.recipes} /></Suspense></div></div>
      {related.length > 0 && <section className="collection-other page-width"><div className="collection-section-heading"><h2>{pl ? 'Jeszcze więcej inspiracji' : 'More inspiration'}</h2><Link href={`/${locale}/kolekcje`}>{pl ? 'Wszystkie kolekcje' : 'All collections'} →</Link></div><CollectionCards collections={related.slice(0, 3)} locale={locale} /></section>}
      <CollectionAccent theme={collection.theme} slot="spot" />
    </main><SiteFooter locale={locale} /></CollectionThemeSurface>;
}
