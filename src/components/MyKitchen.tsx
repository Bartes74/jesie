'use client';

import { formatRecipeDuration } from '@/lib/recipe-duration';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, ChefHat, ChevronDown, ClipboardList, Heart, Play } from 'lucide-react';
import { useSavedRecipes } from '@/lib/browser-storage';
import { cookingRecipeVersion } from '@/lib/kitchen-memory';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { getRecipeHref, type Locale } from '@/lib/recipes';
import { useKitchenMemory } from './useKitchenMemory';
import { SectionLink } from './SectionLink';
import { RecipeDietBadge } from './RecipeDietBadge';
import './kitchen.css';

export function MyKitchen({ recipes, locale }: { recipes: PublicRecipe[]; locale: Locale }) {
  const pl = locale === 'pl';
  const [memory] = useKitchenMemory();
  const { savedIds } = useSavedRecipes();
  const [tab, setTab] = useState<'recent' | 'cooked' | 'saved'>('recent');
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const disclosure = disclosureRef.current;
    // Choose the initial state once; native toggling owns subsequent changes.
    if (disclosure && window.matchMedia('(min-width: 701px)').matches) disclosure.open = true;
  }, []);
  const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const active = memory.sessions.filter(session => session.status === 'active' && byId.has(session.recipeId)).slice(0, 3);
  const completed = [...memory.sessions].filter(session => session.status === 'completed').sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0));
  const cookedIds = [...new Set(completed.map(session => session.recipeId))];
  const selectedIds = tab === 'saved' ? [...savedIds].reverse() : tab === 'cooked' ? cookedIds : memory.recent.map(item => item.recipeId);
  const selected = selectedIds.flatMap(id => byId.get(id) ?? []).slice(0, 4);
  const empty = !active.length && !memory.recent.length && !savedIds.length && !cookedIds.length;
  return <section id="my-kitchen" className={`my-kitchen page-width no-print${empty ? ' kitchen-empty' : ''}`} aria-labelledby="my-kitchen-title">
    <details ref={disclosureRef} className="kitchen-disclosure">
      <summary className="kitchen-summary"><h2 id="my-kitchen-title"><span className="kitchen-summary-title"><ChefHat size={24} aria-hidden="true" />{pl ? 'Moja kuchnia' : 'My kitchen'}</span><span className="kitchen-summary-action" aria-hidden="true"><span className="kitchen-expand-label">{pl ? 'Rozwiń' : 'Expand'}</span><span className="kitchen-collapse-label">{pl ? 'Zwiń' : 'Collapse'}</span><ChevronDown size={19} /></span></h2></summary>
      <div className="kitchen-content">
    <div className="kitchen-heading"><p className="eyebrow">{pl ? 'POD RĘKĄ, NA TWOIM URZĄDZENIU' : 'CLOSE AT HAND, ON YOUR DEVICE'}</p><div className="kitchen-heading-links"><Link href={`/${locale}/plan`}><ClipboardList size={17} aria-hidden="true" />{pl ? 'Plan i zakupy' : 'Plan & shopping'}</Link><SectionLink href={`/${locale}?saved=1#recipes`}>{pl ? 'Ulubione' : 'Favourites'}<ArrowUpRight size={17} aria-hidden="true" /></SectionLink></div></div>
    {empty ? <div className="kitchen-welcome"><BookOpen size={25} aria-hidden="true" /><p>{pl ? 'Zapisz pierwszy przepis serduszkiem lub zacznij gotować. Tutaj wrócisz do swoich dań, notatek i rozpoczętych kroków — bez zakładania konta.' : 'Save your first recipe with a heart or start cooking. Return here for your recipes, notes and unfinished steps — no account needed.'}</p><SectionLink href="#recipes">{pl ? 'Wybierz coś na dziś' : 'Choose something for today'}<ArrowUpRight size={17} aria-hidden="true" /></SectionLink></div> : <>
      {active.length > 0 && <div className="kitchen-resume"><h3>{pl ? 'Wróć do gotowania' : 'Continue cooking'}</h3><div className="kitchen-resume-grid">{active.map(session => {
        const recipe = byId.get(session.recipeId)!;
        const current = session.recipeVersion === cookingRecipeVersion(recipe);
        return <Link key={session.id} href={`${getRecipeHref(recipe, locale)}?cook=1#cooking-session`}><Play size={19} aria-hidden="true" /><span><strong><span className="recipe-diet-title"><RecipeDietBadge recipe={recipe} locale={locale} />{recipe.title[locale]}</span></strong><small>{current ? `${session.progress.steps.length}/${recipe.steps.length} ${pl ? 'kroków' : 'steps'}` : pl ? 'Przepis zaktualizowano — zacznij nową sesję' : 'Recipe updated — start a new session'}</small></span><ArrowUpRight size={18} aria-hidden="true" /></Link>;
      })}</div></div>}
      <div className="kitchen-tabs" role="group" aria-label={pl ? 'Twoje przepisy' : 'Your recipes'}>{(['recent', 'cooked', 'saved'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'saved' ? <Heart size={15} aria-hidden="true" /> : value === 'cooked' ? <Check size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}{value === 'recent' ? pl ? 'Ostatnio oglądane' : 'Recently viewed' : value === 'cooked' ? pl ? 'Ugotowane' : 'Cooked' : pl ? 'Ulubione' : 'Favourites'}</button>)}</div>
      {selected.length ? <div className="kitchen-memory-grid">{selected.map(recipe => <Link className="kitchen-memory-card" key={recipe.id} href={getRecipeHref(recipe, locale)}><span><strong><span className="recipe-diet-title"><RecipeDietBadge recipe={recipe} locale={locale} />{recipe.title[locale]}</span></strong><small>{tab === 'cooked' ? pl ? 'Ugotuj ponownie' : 'Cook again' : formatRecipeDuration(recipe.times.total, locale)}{memory.notes[recipe.id] ? pl ? ' · Masz własną notatkę' : ' · Your note is saved' : ''}</small></span><ArrowUpRight size={18} aria-hidden="true" /></Link>)}</div> : <p className="kitchen-tab-empty" role="status">{tab === 'saved' ? pl ? 'Serduszko przy przepisie doda go do tej listy.' : 'Use a recipe’s heart to add it to this list.' : tab === 'cooked' ? pl ? 'Po gotowaniu kliknij „Ugotowane”. Twoje sprawdzone dania pojawią się tutaj.' : 'Choose “Cooked” when you finish. Your tried recipes will appear here.' : pl ? 'Otwórz przepis, żeby mieć go tutaj pod ręką.' : 'Open a recipe to keep it close at hand here.'}</p>}
    </>}
    <p className="kitchen-local-note">{pl ? 'Ulubione, historia i prywatne notatki zapisują się w tej przeglądarce.' : 'Favourites, history and private notes are saved in this browser.'}</p>
      </div>
    </details>
  </section>;
}
