'use client';

import Link from 'next/link';
import type { Locale } from '@/lib/recipes';
import { useCollectionSelection } from './useCollectionSelection';

type CollectionLink = { id: string; path: string; title: string };
function CollectionSetLink({ collection, locale }: { collection: CollectionLink; locale: Locale }) {
  const [selection] = useCollectionSelection(collection.id);
  if (!selection.recipes.length) return null;
  return <li><Link href={`${collection.path}#my-selection`}>{collection.title}<span>{selection.recipes.length} {locale === 'pl' ? 'wybranych dań' : 'selected dishes'} →</span></Link></li>;
}

export function CollectionSetLinks({ collections, locale }: { collections: CollectionLink[]; locale: Locale }) {
  return <section className="collection-plan-links page-width"><h2>{locale === 'pl' ? 'Zestawy na wyjątkowe okazje' : 'Selections for special occasions'}</h2><p>{locale === 'pl' ? 'Zestawy i zakupy do kolekcji znajdziesz na ich stronach. Działają niezależnie od codziennego planu.' : 'Find collection selections and shopping lists on their pages. They are separate from your everyday meal plan.'}</p><ul>{collections.map(collection => <CollectionSetLink collection={collection} key={collection.id} locale={locale} />)}</ul><Link href={`/${locale}/kolekcje`}>{locale === 'pl' ? 'Przejdź do kolekcji' : 'Explore collections'} →</Link></section>;
}
