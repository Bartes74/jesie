'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Check, Copy, Heart, Plus, Printer, Search, ShoppingBasket, Trash2, X } from 'lucide-react';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { categories, type Locale } from '@/lib/recipes';
import { getRecipeDiet, recipeDiets } from '@/lib/recipe-diet';
import { useSavedRecipes } from '@/lib/browser-storage';
import { buildCollectionShopping, collectionRecipeHref, EMPTY_COLLECTION_SELECTION, removeCollectionRecipe, selectCollectionRecipe, type CollectionSelection } from '@/lib/collection-selection';
import { formatShoppingAmount, shoppingText } from '@/lib/shopping';
import { RecipeCard } from './RecipeCatalog';
import { useCollectionSelection } from './useCollectionSelection';
import { recordUsage } from './UsageMetrics';

const normalize = (value: string) => value.toLocaleLowerCase().replaceAll('ł', 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
type CollectionCatalogProps = { collectionId: string; title: string; locale: Locale; recipes: PublicRecipe[] };

export function CollectionCatalog({ collectionId, title, locale, recipes }: CollectionCatalogProps) {
  const pl = locale === 'pl';
  const params = useSearchParams();
  const pathname = usePathname();
  const { savedIds, toggleSaved } = useSavedRecipes();
  const [selection, setSelection] = useCollectionSelection(collectionId);
  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? '';
  const onlySelected = params.get('selected') === '1';
  const onlySaved = params.get('saved') === '1';
  const diet = recipeDiets.find(item => item.id === params.get('diet'))?.id ?? '';
  const time = ['30', '60'].includes(params.get('time') ?? '') ? Number(params.get('time')) : 0;
  const difficulty = ['easy', 'medium'].includes(params.get('difficulty') ?? '') ? params.get('difficulty')! : '';
  const selectedIds = new Set(selection.recipes.map(item => item.recipeId));
  const presentCategories = categories.filter(item => recipes.some(recipe => recipe.categories.includes(item.id)));
  const hasFilters = Boolean(query || category || onlySelected || onlySaved || diet || time || difficulty);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    window.history.replaceState(null, '', `${pathname}${next.size ? `?${next}` : ''}#recipes`);
  }
  function clear() { window.history.replaceState(null, '', `${pathname}#recipes`); }
  const queryWords = normalize(query).trim().split(/\s+/).filter(Boolean);
  const visible = recipes.filter(recipe => {
    const text = normalize([recipe.title.pl, recipe.title.en, recipe.description.pl, recipe.description.en, ...recipe.ingredients.flatMap(item => [item.name.pl, item.name.en])].join(' '));
    return queryWords.every(word => text.includes(word)) && (!category || recipe.categories.some(id => id === category)) && (!onlySelected || selectedIds.has(recipe.id)) && (!onlySaved || savedIds.includes(recipe.id)) && (!diet || getRecipeDiet(recipe) === diet) && (!time || recipe.times.total <= time) && (!difficulty || recipe.difficulty === difficulty);
  });
  if (sort === 'time') visible.sort((a, b) => a.times.total - b.times.total);
  if (sort === 'name') visible.sort((a, b) => a.title[locale].localeCompare(b.title[locale], locale));
  const lastSearch = useRef('');
  useEffect(() => {
    const term = query.trim();
    if (!term) { lastSearch.current = ''; return; }
    const timer = window.setTimeout(() => {
      if (lastSearch.current === term) return;
      lastSearch.current = term;
      recordUsage('search', pathname);
      if (!visible.length) recordUsage('no_results', pathname);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [query, visible.length, pathname]);

  return <div className="collection-catalog">
    <section className="collection-catalog-browser" id="recipes" aria-labelledby="collection-recipes-title">
      <div className="collection-section-heading"><div><p className="eyebrow">{pl ? 'PRZEPISY NA TĘ OKAZJĘ' : 'RECIPES FOR THE OCCASION'}</p><h2 id="collection-recipes-title">{pl ? 'Ułóż swój zestaw.' : 'Make it your own.'}</h2><p>{pl ? 'Wybierz dania, dopasuj porcje i przygotuj wspólną listę zakupów.' : 'Choose your dishes, adjust servings and prepare one shopping list.'}</p></div><a href="#my-selection" className="planning-button"><ShoppingBasket size={18} aria-hidden="true" />{pl ? 'Mój zestaw' : 'My selection'} <span aria-live="polite">({selection.recipes.length})</span></a></div>
      <div className="catalog-search-row"><div className="search-field"><Search size={20} aria-hidden="true" /><label htmlFor="collection-recipe-search" className="sr-only">{pl ? 'Szukaj w kolekcji' : 'Search this collection'}</label><input id="collection-recipe-search" type="search" value={query} onChange={event => update('q', event.target.value)} placeholder={pl ? 'Szukaj przepisu lub składnika w kolekcji…' : 'Search recipes or ingredients in this collection…'} />{query && <button type="button" className="icon-button" onClick={() => update('q', '')} aria-label={pl ? 'Wyczyść wyszukiwanie' : 'Clear search'}><X size={18} /></button>}</div><button type="button" className={`saved-filter${onlySaved ? ' active' : ''}`} aria-pressed={onlySaved} onClick={() => update('saved', onlySaved ? '' : '1')}><Heart size={18} aria-hidden="true" />{pl ? 'Ulubione' : 'Saved'}</button></div>
      <div className="collection-catalog-toolbar"><label>{pl ? 'Kategoria' : 'Category'}<select value={category} onChange={event => update('category', event.target.value)}><option value="">{pl ? 'Wszystkie' : 'All'}</option>{presentCategories.map(item => <option key={item.id} value={item.id}>{item.label[locale]}</option>)}</select></label><button type="button" className={`category-chip${onlySelected ? ' selected' : ''}`} aria-pressed={onlySelected} onClick={() => update('selected', onlySelected ? '' : '1')}><Check size={16} aria-hidden="true" />{pl ? 'Tylko wybrane' : 'Selected only'}</button><label className="collection-sort">{pl ? 'Sortuj' : 'Sort'}<select value={sort} onChange={event => update('sort', event.target.value)}><option value="">{pl ? 'Kolejność redakcji' : 'Editor’s order'}</option><option value="time">{pl ? 'Najszybsze' : 'Quickest'}</option><option value="name">{pl ? 'Alfabetycznie' : 'A–Z'}</option></select></label>{hasFilters && <button type="button" className="clear-filters" onClick={clear}>{pl ? 'Wyczyść filtry' : 'Clear filters'}<X size={14} aria-hidden="true" /></button>}</div>
      <div className="collection-catalog-toolbar collection-extra-filters"><label>{pl ? 'Rodzaj dania' : 'Dietary category'}<select value={diet} onChange={event => update('diet', event.target.value)}><option value="">{pl ? 'Wszystkie' : 'All'}</option>{recipeDiets.map(item => <option key={item.id} value={item.id}>{item.label[locale]}</option>)}</select></label><label>{pl ? 'Czas' : 'Time'}<select value={time || ''} onChange={event => update('time', event.target.value)}><option value="">{pl ? 'Dowolny czas' : 'Any time'}</option><option value="30">{pl ? 'Do 30 min' : 'Up to 30 min'}</option><option value="60">{pl ? 'Do 60 min' : 'Up to 60 min'}</option></select></label><label>{pl ? 'Trudność' : 'Difficulty'}<select value={difficulty} onChange={event => update('difficulty', event.target.value)}><option value="">{pl ? 'Dowolna' : 'Any'}</option><option value="easy">{pl ? 'Łatwy' : 'Easy'}</option><option value="medium">{pl ? 'Średni' : 'Medium'}</option></select></label></div>
      <p className="collection-results" role="status">{pl ? 'Przepisy w kolekcji' : 'Recipes in this collection'}: {visible.length}</p>
      {visible.length ? <div className="recipe-grid">{visible.map((recipe, index) => {
        const selected = selectedIds.has(recipe.id);
        return <RecipeCard key={recipe.id} recipe={recipe} locale={locale} index={index} saved={savedIds.includes(recipe.id)} onSave={() => { toggleSaved(recipe.id); if (!savedIds.includes(recipe.id)) recordUsage('recipe_save', collectionRecipeHref(recipe, locale, collectionId)); }} href={collectionRecipeHref(recipe, locale, collectionId)} showPopular={false} action={<button type="button" className={`collection-select-button${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={() => setSelection(previous => selected ? removeCollectionRecipe(previous, recipe.id) : selectCollectionRecipe(previous, recipe.id, Math.min(24, Math.max(1, Math.round(recipe.baseServings)))))}>{selected ? <Check size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}{pl ? selected ? 'W moim zestawie' : 'Wybierz do zestawu' : selected ? 'In my selection' : 'Add to selection'}</button>} />;
      })}</div> : <div className="empty-state"><h3>{recipes.length ? pl ? 'Brak pasujących przepisów.' : 'No matching recipes.' : pl ? 'Przepisy do tej kolekcji są w przygotowaniu.' : 'Recipes for this collection are being prepared.'}</h3><p>{recipes.length ? pl ? 'Zmień wyszukiwanie lub wyczyść filtry.' : 'Try a different search or clear the filters.' : pl ? 'Zajrzyj ponownie lub wybierz inną kolekcję.' : 'Visit again soon or explore another collection.'}</p>{hasFilters && <button type="button" className="planning-button" onClick={clear}>{pl ? 'Pokaż całą kolekcję' : 'Show the whole collection'}</button>}</div>}
    </section>
    <CollectionSelectionPanel collectionId={collectionId} title={title} locale={locale} recipes={recipes} selection={selection} setSelection={setSelection} />
  </div>;
}

function CollectionSelectionPanel({ collectionId, title, locale, recipes, selection, setSelection }: CollectionCatalogProps & { selection: CollectionSelection; setSelection: (next: CollectionSelection | ((previous: CollectionSelection) => CollectionSelection)) => void }) {
  const pl = locale === 'pl';
  const pathname = usePathname();
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [status, setStatus] = useState('');
  const shopping = useMemo(() => buildCollectionShopping(selection, recipes), [selection, recipes]);
  const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const remaining = shopping.items.filter(item => !selection.checked.includes(item.id));
  const groups = categories.map(category => ({ category, selected: selection.recipes.filter(item => byId.get(item.recipeId)?.primaryCategory === category.id) })).filter(group => group.selected.length);
  async function copy() {
    try { await navigator.clipboard.writeText(`${title}\n${shoppingText(remaining, locale)}`); recordUsage('shopping_copy', pathname); setStatus(pl ? 'Skopiowano produkty, które zostały do kupienia.' : 'Copied the ingredients still to buy.'); }
    catch { setStatus(pl ? 'Nie udało się skopiować listy. Zaznacz i skopiuj ją ręcznie.' : 'Could not copy the list. Select and copy it manually.'); }
  }
  return <section id="my-selection" className="collection-selection" aria-labelledby="collection-selection-title">
    <div className="collection-section-heading collection-selection-header"><div><p className="eyebrow">{pl ? 'PRZY TWOIM STOLE' : 'AT YOUR TABLE'}</p><h2 id="collection-selection-title">{pl ? 'Mój zestaw' : 'My selection'} <span>({selection.recipes.length})</span></h2><p>{pl ? 'Dopasuj porcje osobno dla każdego dania. Zestaw zapisuje się w tej przeglądarce.' : 'Adjust servings for each dish. Your selection stays in this browser.'}</p></div>{selection.recipes.length > 0 && <button type="button" className="planning-text-button" onClick={() => { setSelection(EMPTY_COLLECTION_SELECTION); setShoppingOpen(false); }}>{pl ? 'Wyczyść zestaw' : 'Clear selection'}</button>}</div>
    {!selection.recipes.length && <p className="collection-selection-note">{pl ? 'Zaznacz przepisy powyżej. Możesz wybrać wszystkie dania, których potrzebujesz na tę okazję.' : 'Select recipes above. Choose as many dishes as you need for the occasion.'}</p>}
    <div className="collection-selected-groups">{groups.map(({ category, selected }) => <section key={category.id}><h3>{category.label[locale]}</h3><ul>{selected.map(item => {
      const recipe = byId.get(item.recipeId)!;
      return <li key={item.recipeId}><Link href={collectionRecipeHref(recipe, locale, collectionId)}>{recipe.title[locale]}</Link><label>{pl ? 'Porcje' : 'Servings'}<input type="number" min={1} max={24} value={item.servings} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 24) setSelection(previous => selectCollectionRecipe(previous, item.recipeId, value, item.selection)); }} /></label><button type="button" className="icon-button" aria-label={`${pl ? 'Usuń z zestawu' : 'Remove from selection'}: ${recipe.title[locale]}`} onClick={() => setSelection(previous => removeCollectionRecipe(previous, item.recipeId))}><Trash2 size={17} aria-hidden="true" /></button></li>;
    })}</ul></section>)}</div>
    {shopping.unavailable.length > 0 && <div className="collection-unavailable collection-selected-groups"><h3>{pl ? 'Niedostępne przepisy' : 'Unavailable recipes'}</h3><p>{pl ? 'Te przepisy nie są już dostępne w kolekcji. Nie uwzględniamy ich składników w zakupach.' : 'These recipes are no longer available in this collection. Their ingredients are excluded from shopping.'}</p>{shopping.unavailable.map(item => <button type="button" key={item.recipeId} className="planning-text-button" onClick={() => setSelection(previous => removeCollectionRecipe(previous, item.recipeId))}>{pl ? 'Usuń niedostępny przepis' : 'Remove unavailable recipe'} <Trash2 size={15} aria-hidden="true" /></button>)}</div>}
    {selection.recipes.length > shopping.unavailable.length && <button type="button" className="primary-button collection-shopping-toggle" onClick={() => setShoppingOpen(previous => !previous)} aria-expanded={shoppingOpen} aria-controls="collection-shopping"><ShoppingBasket size={18} aria-hidden="true" />{pl ? shoppingOpen ? 'Ukryj listę zakupów' : 'Utwórz listę zakupów' : shoppingOpen ? 'Hide shopping list' : 'Create shopping list'}</button>}
    {shoppingOpen && selection.recipes.length > shopping.unavailable.length && <section id="collection-shopping" className="collection-shopping" aria-labelledby="collection-shopping-title"><header><div><p>{title}</p><h3 id="collection-shopping-title">{pl ? 'Wspólna lista zakupów' : 'One shopping list'}</h3><p>{pl ? 'Ilości uwzględniają wybrane dania i porcje. Sprawdź własne zapasy przed zakupami.' : 'Quantities cover your selected dishes and servings. Check what you already have before shopping.'}</p></div><div className="collection-shopping-actions"><button type="button" className="planning-button" onClick={() => void copy()} disabled={!remaining.length}><Copy size={16} aria-hidden="true" />{pl ? 'Kopiuj pozostałe' : 'Copy remaining'}</button><button type="button" className="planning-button" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />{pl ? 'Drukuj' : 'Print'}</button></div></header><ul className="shopping-checklist">{shopping.items.map(item => <li key={item.id}><label><input type="checkbox" checked={selection.checked.includes(item.id)} onChange={() => setSelection(previous => ({ ...previous, checked: previous.checked.includes(item.id) ? previous.checked.filter(id => id !== item.id) : [...previous.checked.filter(id => shopping.items.some(product => product.id === id)), item.id] }))} /><span><strong>{item.name[locale]}</strong><small>{formatShoppingAmount(item, locale)}</small></span></label></li>)}</ul>{status && <p role="status" className="planning-note">{status}</p>}</section>}
  </section>;
}
