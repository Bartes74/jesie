'use client';

import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import type { Ingredient, IngredientAmount, IngredientSubstitution, IngredientUnit, Locale } from '@/lib/recipes';

type Props = {
  ingredients: Ingredient[];
  substitutions: IngredientSubstitution[];
  locale: Locale;
  onChange: (items: IngredientSubstitution[]) => void;
};

export function SubstitutionEditor({ ingredients, substitutions, locale, onChange }: Props) {
  const language = locale === 'pl' ? 'PL' : 'EN · UK';
  const change = (id: string, mutate: (item: IngredientSubstitution) => void, keepApproval = false) => {
    const next = structuredClone(substitutions);
    const item = next.find(value => value.id === id);
    if (!item) return;
    mutate(item);
    if (!keepApproval) item.status = 'to_review';
    onChange(next);
  };
  const changeAmount = (id: string, mutate: (amount: IngredientAmount) => void) => change(id, item => { if (item.amount) mutate(item.amount); });

  return <section className="admin-section admin-substitutions">
    <h2>Dobre zamienniki, ten sam pomysł na danie.</h2>
    <p>Alternatywy są osobnymi wskazówkami. Główna lista składników i zdjęcia pokazują podstawowy przepis. Sprawdź oba języki, ilości i wpływ na smak lub konsystencję.</p>
    <div className="admin-notice"><AlertCircle size={18} /><span>Zmiana zamiennika ponownie kieruje go do sprawdzenia. Czytelnicy zobaczą wyłącznie zatwierdzone propozycje.</span></div>
    {substitutions.map((item, index) => <div className="admin-step-editor" key={item.id}>
      <div className="admin-step-editor-header"><strong>Zamiennik {index + 1}</strong><button type="button" className="admin-icon-button" aria-label={`Usuń zamiennik ${index + 1}`} onClick={() => onChange(substitutions.filter(value => value.id !== item.id))}><Trash2 size={17} /></button></div>
      <div className="admin-field-grid">
        <label className="admin-field">Zamiast którego składnika?<select value={item.ingredientId} onChange={event => change(item.id, value => { value.ingredientId = event.target.value; })}><option value="" disabled>Wybierz składnik…</option>{ingredients.map(ingredient => <option key={ingredient.id} value={ingredient.id}>{ingredient.name[locale] || ingredient.name.pl || ingredient.id}</option>)}</select></label>
        <label className="admin-field">Nazwa zamiennika ({language})<input maxLength={500} value={item.name[locale]} onChange={event => change(item.id, value => { value.name[locale] = event.target.value; })} /></label>
      </div>
      <label className="admin-field">Wskazówka i różnice ({language})<textarea rows={3} value={item.note[locale]} onChange={event => change(item.id, value => { value.note[locale] = event.target.value; })} /><small>Opisz proporcję, różnicę w smaku lub konsystencji oraz potrzebną zmianę przygotowania.</small></label>
      <div className="admin-field-grid">
        <label className="admin-field">Rodzaj ilości<select value={item.amount?.kind ?? 'none'} onChange={event => change(item.id, value => {
          const kind = event.target.value;
          value.amount = kind === 'exact' ? { kind: 'exact', value: '' } : kind === 'range' ? { kind: 'range', min: '', max: '' } : kind === 'qualitative' ? { kind: 'qualitative', text: { pl: '', en: '' } } : undefined;
          value.unit = kind === 'exact' || kind === 'range' ? 'g' : undefined;
          value.scaling = 'linear';
        })}><option value="none">Wskazówka bez osobnej ilości</option><option value="exact">Dokładna ilość</option><option value="range">Zakres</option><option value="qualitative">Ilość opisowa</option></select></label>
        {item.amount?.kind === 'exact' && <label className="admin-field">Ilość dla bazowych porcji<input inputMode="decimal" value={item.amount.value} onChange={event => changeAmount(item.id, amount => { if (amount.kind === 'exact') amount.value = event.target.value.replace(',', '.'); })} /></label>}
        {item.amount?.kind === 'range' && <><label className="admin-field">Ilość minimalna<input inputMode="decimal" value={item.amount.min} onChange={event => changeAmount(item.id, amount => { if (amount.kind === 'range') amount.min = event.target.value.replace(',', '.'); })} /></label><label className="admin-field">Ilość maksymalna<input inputMode="decimal" value={item.amount.max} onChange={event => changeAmount(item.id, amount => { if (amount.kind === 'range') amount.max = event.target.value.replace(',', '.'); })} /></label></>}
        {item.amount?.kind === 'qualitative' && <label className="admin-field">Opis ilości ({language})<input value={item.amount.text[locale]} onChange={event => changeAmount(item.id, amount => { if (amount.kind === 'qualitative') amount.text[locale] = event.target.value; })} /></label>}
        {item.amount && item.amount.kind !== 'qualitative' && <><label className="admin-field">Jednostka<select value={item.unit ?? ''} onChange={event => change(item.id, value => { value.unit = event.target.value ? event.target.value as IngredientUnit : undefined; })}><option value="" disabled>Wybierz jednostkę…</option><option value="g">g</option><option value="ml">ml</option><option value="count">szt.</option><option value="tsp">łyżeczka</option><option value="tbsp">łyżka</option></select></label><label className="admin-field">Zmiana liczby porcji<select value={item.scaling ?? 'linear'} onChange={event => change(item.id, value => { value.scaling = event.target.value as 'linear' | 'fixed'; })}><option value="linear">Przeliczaj proporcjonalnie</option><option value="fixed">Zachowaj stałą ilość</option></select></label></>}
      </div>
      <label className="admin-checkbox"><input type="checkbox" checked={item.status === 'approved'} onChange={event => change(item.id, value => { value.status = event.target.checked ? 'approved' : 'to_review'; }, true)} />Sprawdziłem obie wersje językowe, ilość i wskazówkę</label>
    </div>)}
    <button type="button" className="admin-button is-secondary admin-wide-add" disabled={!ingredients.length || substitutions.length >= 100} onClick={() => onChange([...substitutions, { id: `sub-${crypto.randomUUID().slice(0, 8)}`, ingredientId: ingredients[0].id, name: { pl: '', en: '' }, note: { pl: '', en: '' }, status: 'to_review' }])}><Plus size={17} />Dodaj zamiennik</button>
    {!ingredients.length && <p>Najpierw dodaj składniki podstawowego przepisu.</p>}
  </section>;
}
