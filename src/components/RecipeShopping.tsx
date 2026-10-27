'use client';

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { useMemo, useState } from 'react';
import { Copy, ShoppingBasket } from 'lucide-react';
import { useLocalStorage } from '@/lib/browser-storage';
import { EMPTY_PANTRY, isPantryProducts, isOptionalIngredient } from '@/lib/pantry';
import { buildRecipeShopping, combineShoppingLines, formatShoppingAmount, PANTRY_STORAGE_KEY, shoppingText, type ShoppingSelection } from '@/lib/shopping';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { getRecipeHref, type Locale, type UnitSystem } from '@/lib/recipes';
import { PlanAddButton } from './KitchenPlanner';
import { recordUsage } from './UsageMetrics';

const EMPTY_CHECKS: string[] = [];
const validChecks = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 300 && value.every(id => typeof id === 'string' && id.length <= 3000);

export function RecipeShopping({ recipe, locale, servings, units, selection, setSelection }: { recipe: PublicRecipe; locale: Locale; servings: number; units: UnitSystem; selection: ShoppingSelection; setSelection: (next: ShoppingSelection | ((previous: ShoppingSelection) => ShoppingSelection)) => void }) {
  const pl = locale === 'pl';
  const [pantry] = useLocalStorage(PANTRY_STORAGE_KEY, EMPTY_PANTRY, isPantryProducts);
  const [checked, setChecked] = useLocalStorage(`jesie:shopping-checks:v1:${recipe.id}`, EMPTY_CHECKS, validChecks);
  const [status, setStatus] = useState('');
  const lines = useMemo(() => buildRecipeShopping(recipe, servings, pantry, selection), [recipe, servings, pantry, selection]);
  const buy = useMemo(() => combineShoppingLines(lines.filter(line => line.included)), [lines]);
  const owned = useMemo(() => combineShoppingLines(lines.filter(line => line.active && line.owned && !line.included)), [lines]);
  const remaining = buy.filter(item => !checked.includes(item.id));
  const optional = recipe.ingredients.filter(isOptionalIngredient);
  const alternatives = (recipe.substitutions ?? []).filter(item => item.status === 'approved' && recipe.ingredients.some(ingredient => ingredient.id === item.ingredientId));
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${recipe.title[locale]} · ${servings} ${pl ? 'porcji' : 'servings'}\n${shoppingText(remaining, locale, units)}`);
      recordUsage('shopping_copy', getRecipeHref(recipe, locale));
      setStatus(pl ? 'Skopiowano tylko wybrane produkty, które zostały do kupienia.' : 'Copied only the selected ingredients still to buy.');
    } catch { setStatus(pl ? 'Nie udało się skopiować. Zaznacz listę i skopiuj ją ręcznie.' : 'Could not copy. Select and copy the list manually.'); }
  }
  return <section className="recipe-shopping no-print" aria-labelledby={`shopping-${recipe.id}`}>
    <h3 id={`shopping-${recipe.id}`}><ShoppingBasket size={21} strokeWidth={1.5} aria-hidden="true" />{pl ? 'Zakupy do tego przepisu' : 'Shopping for this recipe'}</h3>
    <p className="planning-note">{pl ? 'Lista uwzględnia wybrane porcje i lodówkę. Zapasów nie odejmujemy ilościowo — sprawdź, czy wystarczą.' : 'Your list uses the selected servings and fridge. Stock quantities are unknown — check you have enough.'}</p>
    {buy.length > 0 ? <ul className="shopping-checklist">{buy.map(item => <li key={item.id}><label><input type="checkbox" checked={checked.includes(item.id)} onChange={() => setChecked(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous.filter(id => buy.some(product => product.id === id)), item.id])} /><span><strong>{item.name[locale]}</strong><small>{formatShoppingAmount(item, locale, units)}</small></span></label></li>)}</ul> : <p className="planning-note">{pl ? 'Produkty są już w Twojej lodówce. Sprawdź ich ilości poniżej.' : 'The ingredients are in your fridge. Check quantities below.'}</p>}
    {owned.length > 0 && <details className="shopping-owned"><summary>{pl ? 'Mam — sprawdź ilość' : 'Already have — check quantities'} ({owned.length})</summary><ul>{owned.map(item => <li key={item.id}><span>{item.name[locale]} <small>{formatShoppingAmount(item, locale, units)}</small></span><button type="button" className="planning-text-button" onClick={() => setSelection(previous => ({ ...previous, includeOwnedProductIds: [...new Set([...previous.includeOwnedProductIds, item.productId])] }))}>{pl ? 'Kup mimo to' : 'Buy anyway'}</button></li>)}</ul></details>}
    {selection.includeOwnedProductIds.length > 0 && <button type="button" className="planning-text-button" onClick={() => setSelection(previous => ({ ...previous, includeOwnedProductIds: [] }))}>{pl ? 'Ponownie uwzględnij stan lodówki' : 'Use fridge stock again'}</button>}
    {(optional.length > 0 || alternatives.length > 0) && <details className="shopping-choices"><summary>{pl ? 'Dodatki i zamienniki' : 'Optional ingredients and substitutions'}</summary>
      {optional.map(ingredient => <label className="shopping-optional" key={ingredient.id}><input type="checkbox" checked={selection.optionalIngredientIds.includes(ingredient.id)} onChange={() => setSelection(previous => ({ ...previous, optionalIngredientIds: previous.optionalIngredientIds.includes(ingredient.id) ? previous.optionalIngredientIds.filter(id => id !== ingredient.id) : [...previous.optionalIngredientIds, ingredient.id] }))} /><span>{ingredient.name[locale]} <small>{pl ? 'opcjonalnie' : 'optional'}</small></span></label>)}
      {[...new Set(alternatives.map(item => item.ingredientId))].map(ingredientId => {
        const original = recipe.ingredients.find(item => item.id === ingredientId)!;
        const chosen = alternatives.find(item => item.id === selection.substitutions[ingredientId] && item.ingredientId === ingredientId);
        return <div className="shopping-substitution" key={ingredientId}><label>{original.name[locale]}<select value={chosen?.id ?? ''} onChange={event => setSelection(previous => ({ ...previous, substitutions: { ...previous.substitutions, [ingredientId]: event.target.value } }))}><option value="">{pl ? 'Zostaw oryginalny składnik' : 'Keep the original ingredient'}</option>{alternatives.filter(item => item.ingredientId === ingredientId).map(item => <option key={item.id} value={item.id}>{item.name[locale]}</option>)}</select></label>{chosen && <p className="planning-note">{formatRecipeDurationText(chosen.note[locale], locale)}{!chosen.amount && (pl ? ' Ilość wymaga sprawdzenia; nie przenosimy ilości oryginału.' : ' Check the quantity; the original amount is not reused.')}</p>}</div>;
      })}
    </details>}
    <div className="shopping-actions"><button type="button" className="planning-button" disabled={!remaining.length} onClick={() => void copy()}><Copy size={16} aria-hidden="true" />{pl ? 'Kopiuj do kupienia' : 'Copy shopping list'}</button><PlanAddButton mode="snapshot" recipe={recipe} locale={locale} servings={servings} selection={selection} /></div>
    {status && <p className="planning-note" role="status">{status}</p>}
  </section>;
}
