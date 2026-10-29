'use client';

import { formatRecipeDuration } from '@/lib/recipe-duration';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Check, ClipboardList, Copy, Plus, Trash2 } from 'lucide-react';
import { useLocalStorage } from '@/lib/browser-storage';
import { addMealIfAbsent, addPlannedMeal, buildMealPlanShopping, EMPTY_MEAL_PLAN, isMealPlan, MAX_PLAN_MEALS, MEAL_PLAN_STORAGE_KEY, removePlannedMeal } from '@/lib/meal-plan';
import { EMPTY_PANTRY, isPantryProducts } from '@/lib/pantry';
import { formatShoppingAmount, PANTRY_STORAGE_KEY, shoppingText, type ShoppingSelection } from '@/lib/shopping';
import { getRecipeHref, type Locale } from '@/lib/recipes';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { recordUsage } from './UsageMetrics';
import { SectionLink } from './SectionLink';
import { RecipeDietBadge } from './RecipeDietBadge';
import { recommendPlanRecipes } from '@/lib/meal-plan-recommendations';

type PlanAddProps = { recipe: PublicRecipe; locale: Locale; showPlanLink?: boolean } & (
  { mode?: 'add-only'; servings?: never; selection?: never }
  | { mode: 'snapshot'; servings: number; selection: ShoppingSelection }
);
export function PlanAddButton(props: PlanAddProps) {
  const { recipe, locale } = props;
  const [plan, setPlan] = useLocalStorage(MEAL_PLAN_STORAGE_KEY, EMPTY_MEAL_PLAN, isMealPlan);
  const [notice, setNotice] = useState('');
  const pl = locale === 'pl';
  const existing = plan.meals.some(meal => meal.recipeId === recipe.id);
  const full = !existing && plan.meals.length >= MAX_PLAN_MEALS;
  function add() {
    if (full) return;
    if (props.mode === 'snapshot') setPlan(previous => addPlannedMeal(previous, recipe.id, Math.min(24, Math.max(1, Math.round(props.servings))), props.selection));
    else setPlan(previous => addMealIfAbsent(previous, recipe.id, Math.min(24, Math.max(1, Math.round(recipe.baseServings)))));
    if (!existing) recordUsage('plan_add', getRecipeHref(recipe, locale));
    setNotice(pl ? existing ? 'Zapisano wybrane porcje i zamienniki w planie.' : 'Dodano danie. Otwórz plan, aby wybrać kolejny posiłek lub zobaczyć wspólne zakupy.' : existing ? 'Selected servings and substitutions saved in your plan.' : 'Meal added. Open your plan to choose another meal or see your combined shopping list.');
  }
  return <div className="plan-add">{existing && props.mode !== 'snapshot' ? <span className="planning-in-plan"><Check size={16} aria-hidden="true" />{pl ? 'W planie' : 'In your plan'}</span> : <button type="button" className="planning-button" disabled={full} onClick={add}>{existing ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{pl ? existing ? 'Zaktualizuj w planie' : full ? 'Plan pełny · 3/3' : 'Dodaj do planu' : existing ? 'Update in plan' : full ? 'Plan full · 3/3' : 'Add to plan'}</button>}{props.showPlanLink !== false && <Link href={`/${locale}/plan`} className="planning-text-button">{pl ? 'Otwórz mój plan' : 'Open my plan'} ({plan.meals.length}/3) →</Link>}{notice && existing && <p role="status" className="planning-note">{notice}</p>}</div>;
}

export function KitchenPlanner({ recipes, locale }: { recipes: PublicRecipe[]; locale: Locale }) {
  const pl = locale === 'pl';
  const [plan, setPlan] = useLocalStorage(MEAL_PLAN_STORAGE_KEY, EMPTY_MEAL_PLAN, isMealPlan);
  const [pantry] = useLocalStorage(PANTRY_STORAGE_KEY, EMPTY_PANTRY, isPantryProducts);
  const [copyStatus, setCopyStatus] = useState('');
  const byId = useMemo(() => new Map(recipes.map(recipe => [recipe.id, recipe])), [recipes]);
  const shopping = useMemo(() => buildMealPlanShopping(plan, recipes, pantry), [plan, recipes, pantry]);
  const recommendations = useMemo(() => recommendPlanRecipes(recipes, plan.meals), [recipes, plan.meals]);
  const unchecked = shopping.buy.filter(item => !plan.checked.includes(item.id));
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${pl ? 'Lista zakupów — mój plan' : 'Shopping list — my plan'}\n${shoppingText(unchecked, locale)}`);
      recordUsage('shopping_copy', `/${locale}/plan`);
      setCopyStatus(pl ? 'Skopiowano produkty, które zostały do kupienia.' : 'Copied the ingredients still to buy.');
    } catch { setCopyStatus(pl ? 'Nie udało się skopiować. Zaznacz produkty i skopiuj je ręcznie.' : 'Could not copy. Select the ingredients and copy them manually.'); }
  }
  return <section className="kitchen-planner page-width no-print" id="meal-plan" aria-labelledby="meal-plan-title">
    <div className="planning-heading"><div><p className="eyebrow">{pl ? 'TWOJE KOLEJNE POSIŁKI' : 'YOUR NEXT MEALS'}</p><h2 id="meal-plan-title">{pl ? 'Mój plan' : 'My plan'} <span className="plan-count" role="status">{plan.meals.length}/3</span></h2><p>{pl ? 'Możesz zaplanować od jednego do trzech dań. Zakupy pojawią się od razu po dodaniu pierwszego. Plan zapisuje się w tej przeglądarce.' : 'Plan one to three meals. Your shopping list appears as soon as you add the first. Your plan stays in this browser.'}</p></div><ClipboardList size={32} strokeWidth={1.3} aria-hidden="true" /></div>
    {plan.meals.length ? <div className="planned-meals">{plan.meals.map((meal, index) => {
      const recipe = byId.get(meal.recipeId);
      return <article className="planned-meal" key={meal.recipeId}><span className="planned-number">0{index + 1}</span><div>{recipe ? <Link href={getRecipeHref(recipe, locale)}><h3><span className="recipe-diet-title"><RecipeDietBadge recipe={recipe} locale={locale} />{recipe.title[locale]}</span></h3></Link> : <h3>{pl ? 'Ten przepis jest chwilowo niedostępny' : 'This recipe is currently unavailable'}</h3>}{recipe ? <label>{pl ? 'Porcje' : 'Servings'} <input type="number" min={1} max={24} value={meal.servings} onChange={event => {
        const value = Number(event.target.value);
        if (Number.isInteger(value) && value >= 1 && value <= 24) setPlan(previous => addPlannedMeal(previous, meal.recipeId, value, meal.selection));
      }} /></label> : <p className="planning-note">{pl ? 'Nie dodajemy jego składników do zakupów.' : 'Its ingredients are excluded from the shopping list.'}</p>}</div><button type="button" className="planning-icon-button" aria-label={`${pl ? 'Usuń z planu' : 'Remove from plan'}: ${recipe?.title[locale] ?? index + 1}`} onClick={() => {
        setPlan(previous => removePlannedMeal(previous, meal.recipeId));
        recordUsage('plan_remove', recipe ? getRecipeHref(recipe, locale) : `/${locale}`);
      }}><Trash2 size={18} aria-hidden="true" /></button></article>;
    })}{Array.from({ length: MAX_PLAN_MEALS - plan.meals.length }, (_, index) => <SectionLink key={index} className="planned-empty" href={`/${locale}/plan#recipes`}><Plus size={20} aria-hidden="true" />{pl ? 'Wybierz kolejny przepis' : 'Choose another recipe'}</SectionLink>)}</div> : <div className="planning-empty"><div><strong>{pl ? 'Zacznij od pierwszego dania' : 'Start with your first meal'}</strong><p>{pl ? 'Wybierz przepis poniżej i kliknij „Dodaj do planu”. Możesz też najpierw go przeczytać — ten sam przycisk znajdziesz przy tytule.' : 'Choose a recipe below and select “Add to plan”. You can read it first — the same button is beside its title.'}</p></div><SectionLink href={`/${locale}/plan#recipes`} className="planning-button">{pl ? 'Wybierz pierwszy posiłek' : 'Choose your first meal'}<Plus size={16} aria-hidden="true" /></SectionLink></div>}
    {recommendations.length > 0 && <section className="plan-recommendations" aria-labelledby="plan-recommendations-title"><h3 id="plan-recommendations-title">{pl ? 'Wykorzystaj te same produkty' : 'Make more of the same ingredients'}</h3><p>{pl ? 'Dobierz kolejne danie do tego, co już jest w Twoim planie.' : 'Choose another dish using ingredients already in your plan.'}</p><div className="plan-recommendation-grid">{recommendations.map(({ recipe, sharedProducts }) => <article key={recipe.id}><Link href={getRecipeHref(recipe, locale)}><h4><span className="recipe-diet-title"><RecipeDietBadge recipe={recipe} locale={locale} />{recipe.title[locale]}</span></h4></Link><p><strong>{pl ? 'Wykorzystasz też' : 'Also uses'}:</strong> {sharedProducts.slice(0, 3).map(product => product.name[locale]).join(', ')}{sharedProducts.length > 3 ? ` +${sharedProducts.length - 3}` : ''}</p><small>{formatRecipeDuration(recipe.times.total, locale)}</small><PlanAddButton recipe={recipe} locale={locale} /></article>)}</div></section>}
    {plan.meals.length > 0 && <div className="plan-shopping"><div className="planning-heading"><div><h3>{pl ? 'Jedna lista zakupów' : 'One shopping list'}</h3><p>{pl ? 'Ilości obejmują cały plan. Produkty z lodówki wymagają sprawdzenia ilości; nie odejmujemy nieznanych zapasów.' : 'Quantities cover the whole plan. Check how much you have in your fridge; unknown stock amounts are not deducted.'}</p></div><button type="button" className="planning-button" disabled={!unchecked.length} onClick={() => void copy()}><Copy size={16} aria-hidden="true" />{pl ? 'Kopiuj pozostałe' : 'Copy remaining'}</button></div>
      {shopping.buy.length ? <ul className="shopping-checklist">{shopping.buy.map(item => <li key={item.id}><label><input type="checkbox" checked={plan.checked.includes(item.id)} onChange={() => setPlan(previous => ({ ...previous, checked: previous.checked.includes(item.id) ? previous.checked.filter(id => id !== item.id) : [...previous.checked.filter(id => shopping.buy.some(product => product.id === id)), item.id] }))} /><span><strong>{item.name[locale]}</strong><small>{formatShoppingAmount(item, locale)}</small></span></label></li>)}</ul> : <p className="planning-note">{pl ? 'Produkty są już na liście lodówki. Przed gotowaniem sprawdź ich ilości.' : 'The ingredients are already in your fridge list. Check quantities before cooking.'}</p>}
      {shopping.owned.length > 0 && <details className="shopping-owned"><summary>{pl ? 'Mam — sprawdź ilość' : 'Already have — check quantities'} ({shopping.owned.length})</summary><ul>{shopping.owned.map(item => <li key={item.id}><span>{item.name[locale]} <small>{formatShoppingAmount(item, locale)}</small></span><button type="button" className="planning-text-button" onClick={() => setPlan(previous => ({ ...previous, includeOwnedProductIds: [...new Set([...previous.includeOwnedProductIds, item.productId])] }))}>{pl ? 'Dodaj do zakupów' : 'Add to shopping'}</button></li>)}</ul></details>}
      {(plan.includeOwnedProductIds.length > 0 || plan.meals.some(meal => meal.selection.includeOwnedProductIds.length > 0)) && <button type="button" className="planning-text-button" onClick={() => setPlan(previous => ({ ...previous, includeOwnedProductIds: [], meals: previous.meals.map(meal => ({ ...meal, selection: { ...meal.selection, includeOwnedProductIds: [] } })) }))}>{pl ? 'Ponownie uwzględnij stan lodówki' : 'Use fridge stock again'}</button>}
      {copyStatus && <p role="status" className="planning-note">{copyStatus}</p>}
    </div>}
  </section>;
}
