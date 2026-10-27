import Link from 'next/link';
import type { Locale } from '@/lib/recipes';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { getGuideHref, getPublishedCollections, guides } from '@/lib/content-hubs';
import type { PublicCollection } from '@/lib/collections';

export function ContentHubLinks({ locale, recipes, publishedCollections }: { locale: Locale; recipes: readonly PublicRecipe[]; publishedCollections?: PublicCollection[] }) {
  const published = publishedCollections ?? getPublishedCollections(recipes, locale);
  return <section className="content-hubs page-width" aria-labelledby="hubs-title">
    <p className="eyebrow">{locale === 'pl' ? 'POMOC W CODZIENNYM GOTOWANIU' : 'HELP WITH EVERYDAY COOKING'}</p>
    <h2 id="hubs-title">{locale === 'pl' ? 'Inspiracje na każdą okazję.' : 'Inspiration for every occasion.'}</h2>
    <div className="content-hub-grid">
      {published.map(item => <Link key={item.id} href={item.path}><span>{locale === 'pl' ? `${item.recipes.length} przepisów` : `${item.recipes.length} recipes`}</span><h3>{item.title[locale]}</h3><p>{item.description[locale]}</p></Link>)}
      {guides.map(guide => <Link key={guide.slug.pl} href={getGuideHref(guide, locale)}><span>{locale === 'pl' ? 'Poradnik' : 'Guide'}</span><h3>{guide.title[locale]}</h3><p>{guide.description[locale]}</p></Link>)}
    </div>
    <p className="collection-all-recipes"><Link href={`/${locale}/kolekcje`}>{locale === 'pl' ? 'Wszystkie kolekcje przez cały rok' : 'Explore collections all year'} →</Link></p>
  </section>;
}
