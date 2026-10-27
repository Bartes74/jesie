"use client";

import { useMemo, useState } from 'react';
import { Check, Plus, Search, Star, X } from 'lucide-react';
import { searchIngredientCatalog, type IngredientProduct } from '@/lib/ingredient-catalog';
import { MAX_PANTRY_PRODUCTS } from '@/lib/pantry';
import type { Locale } from '@/lib/recipes';

export function Pantry({ locale, products, selectedIds, onChange, priorityIds = [], onPriorityChange, applied = false, onAppliedChange }: { locale: Locale; products: IngredientProduct[]; selectedIds: string[]; onChange: (ids: string[]) => void; priorityIds?: string[]; onPriorityChange?: (ids: string[]) => void; applied?: boolean; onAppliedChange?: (applied: boolean) => void }) {
  const pl = locale === 'pl';
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const byId = useMemo(() => new Map(products.map(item => [item.id, item])), [products]);
  const suggestions = useMemo(() => searchIngredientCatalog(products, query, locale), [products, query, locale]);
  const selectedName = (id: string) => byId.get(id)?.name[locale] ?? (id.startsWith('literal:') ? id.slice(8).split('|')[pl ? 0 : 1] ?? id.slice(8).split('|')[0] : id);
  const full = selectedIds.length >= MAX_PANTRY_PRODUCTS;
  const displayedSuggestions = showAll || query.trim() ? suggestions : suggestions.slice(0, 12);
  return <div className="pantry-panel" id="pantry-panel">
    <p className="pantry-intro">{pl ? 'Wybierz produkty, które masz pod ręką. Pokażemy, co możesz ugotować i czego jeszcze brakuje.' : 'Choose the ingredients you have to hand. See what you can cook and what else you need.'}</p>
    <div className="pantry-search search-field"><Search size={18} aria-hidden="true" /><label className="sr-only" htmlFor="pantry-search">{pl ? 'Wyszukaj produkt do lodówki' : 'Find an ingredient for your fridge'}</label><input id="pantry-search" type="search" autoComplete="off" maxLength={100} placeholder={pl ? 'Dodaj produkt, np. mleko…' : 'Add an ingredient, e.g. milk…'} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="icon-button" onClick={() => setQuery('')} aria-label={pl ? 'Wyczyść nazwę produktu' : 'Clear ingredient search'}><X size={17} aria-hidden="true" /></button>}</div>
    <div className="pantry-selected-heading"><span>{pl ? 'W mojej lodówce' : 'In my fridge'} <small>{selectedIds.length}/{MAX_PANTRY_PRODUCTS}</small></span>{selectedIds.length > 0 && <button type="button" onClick={() => onChange([])}>{pl ? 'Wyczyść listę' : 'Clear list'}</button>}</div>
    {selectedIds.length > 0 ? <ul className="pantry-selected">{selectedIds.map(id => <li key={id}><button type="button" onClick={() => onChange(selectedIds.filter(item => item !== id))} aria-label={`${pl ? 'Usuń' : 'Remove'}: ${selectedName(id)}`}><Check size={14} aria-hidden="true" />{selectedName(id)}<X size={14} aria-hidden="true" /></button>{onPriorityChange && <button type="button" className={`pantry-priority${priorityIds.includes(id) ? ' is-priority' : ''}`} aria-pressed={priorityIds.includes(id)} aria-label={`${pl ? 'Zużyj najpierw' : 'Use first'}: ${selectedName(id)}`} disabled={!priorityIds.includes(id) && priorityIds.length >= 3} onClick={() => onPriorityChange(priorityIds.includes(id) ? priorityIds.filter(item => item !== id) : [...priorityIds, id])}><Star size={15} fill={priorityIds.includes(id) ? 'currentColor' : 'none'} aria-hidden="true" /></button>}</li>)}</ul> : <p className="pantry-selection-empty">{pl ? 'Dodaj pierwszy produkt z listy poniżej.' : 'Add your first ingredient from the list below.'}</p>}
    {onPriorityChange && selectedIds.length > 0 && <p className="planning-note">{pl ? 'Gwiazdka = zużyj najpierw. Wybierz maksymalnie 3 produkty.' : 'Star ingredients to use first. Choose up to 3.'} {priorityIds.length}/3</p>}
    <p className="pantry-device-note">{pl ? 'Lista zapisuje się na tym urządzeniu. Nie musisz podawać ilości ani zakładać konta.' : 'Your list stays on this device. No quantities or account needed.'}</p>
    <div className="pantry-suggestions" role="group" aria-label={pl ? 'Podpowiedzi produktów' : 'Ingredient suggestions'}>{displayedSuggestions.map(product => {
      const selected = selectedIds.includes(product.id);
      return <button key={product.id} type="button" aria-pressed={selected} disabled={full && !selected} onClick={() => onChange(selected ? selectedIds.filter(id => id !== product.id) : [...selectedIds, product.id])} className={selected ? 'selected' : ''}>{selected ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{product.name[locale]}</button>;
    })}</div>
    {!query.trim() && suggestions.length > 12 && <button type="button" className="pantry-more" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? pl ? 'Pokaż mniej produktów' : 'Show fewer ingredients' : pl ? 'Więcej produktów' : 'More ingredients'}</button>}
    <p className="pantry-search-status" role="status">{full ? pl ? 'Masz już 30 produktów. Usuń jeden, żeby dodać kolejny.' : 'You have 30 ingredients. Remove one to add another.' : !suggestions.length ? pl ? 'Nie znaleziono produktu. Spróbuj innej nazwy.' : 'No ingredients found. Try another name.' : ''}</p>
    {onAppliedChange && <label className="pantry-apply"><input type="checkbox" checked={applied} disabled={!selectedIds.length && !applied} onChange={event => onAppliedChange(event.target.checked)} /><span><strong>{pl ? 'Używaj mojej lodówki przy wyborze przepisów' : 'Use my fridge when choosing recipes'}</strong><small>{pl ? 'Zwinięcie panelu nie wyłącza dopasowania.' : 'Collapsing this panel keeps matching enabled.'}</small></span></label>}
  </div>;
}
