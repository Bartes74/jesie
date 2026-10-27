'use client';

import { ClipboardList } from 'lucide-react';
import { useLocalStorage } from '@/lib/browser-storage';
import { EMPTY_MEAL_PLAN, isMealPlan, MEAL_PLAN_STORAGE_KEY } from '@/lib/meal-plan';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import type { ShoppingSelection } from '@/lib/shopping';
import { PlanAddButton } from './KitchenPlanner';

export function RecipePlanActions({ recipe, locale, servings, selection, onServingsChange }: { recipe: PublicRecipe; locale: Locale; servings: number; selection: ShoppingSelection; onServingsChange: (value: number) => void }) {
  const pl = locale === 'pl';
  const [plan] = useLocalStorage(MEAL_PLAN_STORAGE_KEY, EMPTY_MEAL_PLAN, isMealPlan);
  const meal = plan.meals.find(item => item.recipeId === recipe.id);
  return <section className="recipe-plan-actions no-print" aria-labelledby="recipe-plan-title">
    <h2 id="recipe-plan-title"><ClipboardList size={19} aria-hidden="true" />{meal ? pl ? 'To danie jest w Twoim planie' : 'This meal is in your plan' : pl ? 'Zaplanuj ten posiłek' : 'Plan this meal'}</h2>
    <p>{meal ? pl ? `W planie: ${meal.servings} porcji. Zmiany porcji i zamienników zapiszesz przyciskiem poniżej.` : `In your plan: ${meal.servings} servings. Save changes to servings and substitutions using the button below.` : pl ? 'Ustaw porcje i dodaj danie. W swoim planie dobierzesz kolejne posiłki i znajdziesz wspólną listę zakupów.' : 'Set your servings and add the meal. Open your plan to choose more meals and find your combined shopping list.'}</p>
    <label className="recipe-plan-servings">{pl ? 'Porcje do planu' : 'Servings to plan'}<input type="number" min={1} max={24} value={servings} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 24) onServingsChange(value); }} /></label>
    <PlanAddButton mode="snapshot" recipe={recipe} locale={locale} servings={servings} selection={selection} />
  </section>;
}
