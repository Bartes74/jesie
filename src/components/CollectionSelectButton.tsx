'use client';

import Link from 'next/link';
import { Check, Plus } from 'lucide-react';
import { selectCollectionRecipe } from '@/lib/collection-selection';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import type { ShoppingSelection } from '@/lib/shopping';
import { useCollectionSelection } from './useCollectionSelection';

export function CollectionSelectButton({ collection, recipe, locale, servings, selection }: { collection: { id: string; path: string; title: string }; recipe: PublicRecipe; locale: Locale; servings: number; selection: ShoppingSelection }) {
  const [state, setState] = useCollectionSelection(collection.id);
  const exists = state.recipes.some(item => item.recipeId === recipe.id);
  const pl = locale === 'pl';
  return <div className="collection-recipe-action no-print"><button type="button" className="planning-button" onClick={() => setState(previous => selectCollectionRecipe(previous, recipe.id, servings, selection))}>{exists ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{pl ? exists ? 'Zaktualizuj w moim zestawie' : 'Wybierz do mojego zestawu' : exists ? 'Update my selection' : 'Add to my selection'}</button><Link href={`${collection.path}#my-selection`}>{pl ? 'Mój zestaw' : 'My selection'} · {collection.title}</Link><p role="status">{exists ? pl ? 'Danie jest w Twoim zestawie. Przycisk zapisuje aktualne porcje i zamienniki.' : 'This dish is selected. The button saves the current servings and substitutions.' : pl ? 'Wybrane dania i wspólną listę zakupów znajdziesz w kolekcji.' : 'Find your selected dishes and combined shopping list in the collection.'}</p></div>;
}
