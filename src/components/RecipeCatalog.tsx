"use client";

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { formatRecipeDuration } from '@/lib/recipe-duration';
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowUpRight, Search, X, Heart, Clock3, SlidersHorizontal, Utensils, Soup, Salad, CakeSlice, Croissant, Wheat, CookingPot, Grid2X2, Leaf, Carrot, ChevronDown, ChevronUp } from "lucide-react";
import { categories, getRecipeHref, type Locale } from "@/lib/recipes";
import { useLocalStorage, useSavedRecipes } from "@/lib/browser-storage";
import { buildIngredientCatalog, canonicalizeProductIds } from "@/lib/ingredient-catalog";
import { comparePantryMatches, EMPTY_PANTRY, isPantryProducts, isPopularNow, matchPantryRecipes, pantryMatchReasons, type PantryMatch } from "@/lib/pantry";
import { Pantry } from "./Pantry";
import { RecipeHeroImage } from './RecipeHeroImage';
import type { PublicRecipe } from "@/lib/recipe-presentation";
import { formatServingCount } from "@/lib/locale-format";
import { PANTRY_FIRST_STORAGE_KEY, PANTRY_STORAGE_KEY, PANTRY_USE_STORAGE_KEY } from '@/lib/shopping';
import { PlanAddButton } from './KitchenPlanner';
import { recordUsage } from './UsageMetrics';
import { EMPTY_MEAL_PLAN, isMealPlan, MEAL_PLAN_STORAGE_KEY } from '@/lib/meal-plan';
import { SectionLink } from './SectionLink';
import { getRecipeDiet, recipeDiets } from '@/lib/recipe-diet';
import { RecipeDietBadge, RecipeDietIcon } from './RecipeDietBadge';

const CATEGORY_ICONS = [Croissant, Utensils, Salad, Leaf, Soup, CookingPot, CakeSlice, Croissant, Wheat, CookingPot];
const normalize = (value: string) => value.toLowerCase().replaceAll("ł", "l").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function RecipeCatalog({ locale, recipes, mode = 'browse' }: { locale: Locale; recipes: PublicRecipe[]; mode?: 'browse' | 'plan' }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const { savedIds, toggleSaved } = useSavedRecipes();
  const [plan] = useLocalStorage(MEAL_PLAN_STORAGE_KEY, EMPTY_MEAL_PLAN, isMealPlan);
  const [storedPantry, setPantryProducts] = useLocalStorage(PANTRY_STORAGE_KEY, EMPTY_PANTRY, isPantryProducts);
  const [pantryApplied, setPantryApplied] = useLocalStorage(PANTRY_USE_STORAGE_KEY, false, (value): value is boolean => typeof value === 'boolean');
  const [storedFirst, setPriorityProducts] = useLocalStorage(PANTRY_FIRST_STORAGE_KEY, EMPTY_PANTRY, isPantryProducts);
  const productCatalog = useMemo(() => buildIngredientCatalog(recipes), [recipes]);
  const pantryProducts = useMemo(() => canonicalizeProductIds(storedPantry, productCatalog), [storedPantry, productCatalog]);
  const priorityProducts = useMemo(() => canonicalizeProductIds(storedFirst, productCatalog).filter(id => pantryProducts.includes(id)).slice(0, 3), [storedFirst, productCatalog, pantryProducts]);
  const pantryMatches = useMemo(() => matchPantryRecipes(recipes, pantryProducts, priorityProducts), [recipes, pantryProducts, priorityProducts]);
  const pantryByRecipe = useMemo(() => new Map(pantryMatches.map(match => [match.recipe.id, match])), [pantryMatches]);
  const pl = locale === "pl";
  const query = params.get("q") ?? "";
  const selected = (params.get("category") ?? "").split(",").filter(Boolean);
  const time = Number(params.get("time") || 0);
  const difficulty = params.get("difficulty") ?? "";
  const requestedDiet = params.get('diet');
  const diet = recipeDiets.find(item => item.id === requestedDiet)?.id ?? '';
  const requestedSort = params.get("sort");
  const sort = requestedSort === "featured" || requestedSort === "time" || requestedSort === "name" ? requestedSort : "newest";
  const onlySaved = params.get("saved") === "1";
  const pantryOpen = params.get('pantry') === '1';
  const pantryActive = pantryApplied && pantryProducts.length > 0;
  const hasFilters = !!(query || selected.length || diet || time || difficulty || onlySaved || pantryActive);
  const extraFilters = [diet, time, difficulty].filter(Boolean).length;
  // Less-used filters stay folded; active ones keep the panel open on load.
  const [filtersOpen, setFiltersOpen] = useState(extraFilters > 0);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (key !== 'diet') next.delete('collection');
    if (value) next.set(key, value); else next.delete(key);
    window.history.replaceState(null, "", `${pathname}${next.size ? `?${next}` : ""}${window.location.hash}`);
  }
  function clear() { setPantryApplied(false); window.history.replaceState(null, "", `${pathname}#recipes`); }
  const visible = recipes.filter(recipe => {
    const words = normalize(query).trim().split(/\s+/).filter(Boolean);
    const haystack = normalize([recipe.title.pl, recipe.title.en, recipe.description.pl, recipe.description.en, ...recipe.ingredients.flatMap(ingredient => [ingredient.name.pl, ingredient.name.en]), ...recipe.categories.flatMap(id => {
      const category = categories.find(item => item.id === id);
      return category ? [category.label.pl, category.label.en] : [id];
    })].join(" "));
    return words.every(word => haystack.includes(word)) && (!selected.length || selected.some(id => recipe.categories.some(category => category === id))) && (!diet || getRecipeDiet(recipe) === diet) && (!time || recipe.times.total <= time) && (!difficulty || recipe.difficulty === difficulty) && (!onlySaved || savedIds.includes(recipe.id)) && (!pantryActive || pantryByRecipe.has(recipe.id));
  }).sort((a, b) => {
    if (pantryActive) {
      const left = pantryByRecipe.get(a.id)!;
      const right = pantryByRecipe.get(b.id)!;
      return comparePantryMatches(left, right);
    }
    if (sort === "time") return a.times.total - b.times.total;
    if (sort === "name") return a.title[locale].localeCompare(b.title[locale], locale);
    if (sort === "featured") return Number(b.featured) - Number(a.featured);
    // Only the first publication determines recency; later edits do not promote a recipe.
    return (Date.parse(b.publication?.datePublished ?? "") || 0) - (Date.parse(a.publication?.datePublished ?? "") || 0);
  });
  const lastSearch = useRef('');
  useEffect(() => {
    const term = query.trim();
    if (!term) { lastSearch.current = ''; return; }
    const timeout = window.setTimeout(() => {
      if (lastSearch.current === term) return;
      lastSearch.current = term;
      recordUsage('search', pathname);
      if (!visible.length) recordUsage('no_results', pathname);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [query, visible.length, pathname]);

  return <>
    {mode === 'plan' && <div className="plan-picker-context"><div><strong>{pl ? 'Wybierasz dania do planu' : 'Choosing meals for your plan'} <span aria-live="polite">{plan.meals.length}/3</span></strong><p>{pl ? 'Kliknij „Dodaj do planu” na karcie lub otwórz przepis i dodaj go przy tytule.' : 'Select “Add to plan” on a card, or open a recipe and add it beside its title.'}</p></div><SectionLink href={`${pathname}${params.size ? `?${params}` : ''}#meal-plan`} className="planning-button">{pl ? 'Zobacz mój plan' : 'View my plan'} →</SectionLink></div>}
    <div className="catalog-search-row"><div className="search-field"><Search size={21} strokeWidth={1.6} aria-hidden="true" /><label className="sr-only" htmlFor="recipe-search">{pl ? "Szukaj przepisu lub składnika" : "Search recipes or ingredients"}</label><input id="recipe-search" type="search" autoComplete="off" value={query} placeholder={pl ? "Szukaj przepisu lub składnika…" : "Search a recipe or ingredient…"} onChange={event => update("q", event.target.value)} />{query && <button className="icon-button" type="button" onClick={() => update("q", "")} aria-label={pl ? "Wyczyść wyszukiwanie" : "Clear search"}><X size={19} /></button>}</div>
      <button className={`saved-filter ${onlySaved ? "active" : ""}`} type="button" aria-pressed={onlySaved} onClick={() => update("saved", onlySaved ? "" : "1")}><Heart size={18} fill={onlySaved ? "currentColor" : "none"} strokeWidth={1.6} />{pl ? "Moje ulubione" : "My favourites"}</button></div>
    <div className={`pantry-tool${pantryOpen ? ' is-open' : ''}`}><button type="button" className="pantry-toggle" aria-expanded={pantryOpen} aria-controls="pantry-panel" onClick={() => update('pantry', pantryOpen ? '' : '1')}><Carrot size={22} strokeWidth={1.5} aria-hidden="true" /><span><strong>{pl ? 'Co mam w lodówce?' : 'What’s in my fridge?'}</strong><small>{pantryActive ? pl ? 'Dopasowanie włączone — także po zwinięciu panelu.' : 'Matching stays enabled when the panel is collapsed.' : pl ? 'Znajdź przepis z tego, co już masz.' : 'Find a recipe with what you already have.'}</small></span>{pantryProducts.length > 0 && <span className="pantry-count">{pantryProducts.length}</span>}{pantryOpen ? <ChevronUp size={19} aria-hidden="true" /> : <ChevronDown size={19} aria-hidden="true" />}</button>{pantryOpen && <Pantry locale={locale} products={productCatalog} selectedIds={pantryProducts} priorityIds={priorityProducts} onPriorityChange={setPriorityProducts} applied={pantryApplied} onAppliedChange={value => { setPantryApplied(value); if (value) recordUsage('pantry_use', pathname); }} onChange={ids => { setPantryProducts(ids); setPriorityProducts(previous => previous.filter(id => ids.includes(id))); }} />}</div>
    {pantryActive && !pantryOpen && <button type="button" className="planning-text-button pantry-disable" onClick={() => setPantryApplied(false)}>{pl ? 'Wyłącz dopasowanie do lodówki' : 'Turn off fridge matching'}</button>}
    <div className="category-filters" role="group" aria-label={pl ? "Kategorie przepisów" : "Recipe categories"}>
      <button type="button" className={`category-chip ${!selected.length ? "selected" : ""}`} aria-pressed={!selected.length} onClick={() => update("category", "")}><Grid2X2 size={16} strokeWidth={1.6} />{pl ? "Wszystkie" : "All recipes"}</button>
      {categories.map((category, index) => {
        const Icon = CATEGORY_ICONS[index % CATEGORY_ICONS.length];
        const active = selected.includes(category.id);
        return <button key={category.id} type="button" aria-pressed={active} className={`category-chip ${active ? "selected" : ""}`} onClick={() => update("category", (active ? selected.filter(id => id !== category.id) : [...selected, category.id]).join(","))}><Icon size={17} strokeWidth={1.5} />{category.label[locale]}</button>;
      })}
    </div>
    <div className="catalog-toolbar"><div className="filter-controls"><button type="button" className="filters-toggle" aria-expanded={filtersOpen} aria-controls="catalog-filter-panel" onClick={() => setFiltersOpen(open => !open)}><SlidersHorizontal size={17} strokeWidth={1.5} aria-hidden="true" />{pl ? "Filtry" : "Filters"}{extraFilters > 0 && <span className="filters-count">{extraFilters}</span>}{filtersOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>{hasFilters && <button type="button" className="clear-filters" onClick={clear}>{pl ? "Wyczyść" : "Clear"}<X size={13} /></button>}</div>
      {pantryActive ? <span className="pantry-sort-note">{pl ? 'Najpierw produkty do zużycia i główne składniki' : 'Use-first ingredients and main ingredients come first'}</span> : <label className="sort-control"><span>{pl ? "Sortuj:" : "Sort:"}</span><select value={sort} onChange={event => update("sort", event.target.value === "newest" ? "" : event.target.value)}><option value="newest">{pl ? "Najnowsze" : "Newest"}</option><option value="featured">{pl ? "Polecane" : "Featured"}</option><option value="time">{pl ? "Najszybsze" : "Quickest"}</option><option value="name">{pl ? "Alfabetycznie" : "A–Z"}</option></select></label>}</div>
    {filtersOpen && <div id="catalog-filter-panel" className="catalog-filter-panel">
      <div className="diet-filters" role="group" aria-label={pl ? 'Rodzaj dania' : 'Dietary category'}>
        <span className="diet-filter-label" aria-hidden="true">{pl ? 'Rodzaj dania' : 'Dietary category'}</span>
        <button type="button" className={`category-chip ${!diet ? 'selected' : ''}`} aria-pressed={!diet} onClick={() => update('diet', '')}>{pl ? 'Wszystkie' : 'All'}</button>
        {recipeDiets.map(item => <button key={item.id} type="button" className={`category-chip ${diet === item.id ? 'selected' : ''}`} aria-pressed={diet === item.id} title={item.id === 'meat' ? pl ? 'Z mięsem, rybami lub innymi składnikami niewegetariańskimi' : 'Contains meat, fish or other non-vegetarian ingredients' : item.label[locale]} onClick={() => update('diet', item.id)}><RecipeDietIcon diet={item.id} />{item.label[locale]}</button>)}
      </div>
      <div className="filter-controls"><label><span className="sr-only">{pl ? "Czas przygotowania" : "Total time"}</span><select value={time || ""} onChange={event => update("time", event.target.value)}><option value="">{pl ? "Dowolny czas" : "Any time"}</option><option value="30">{`${pl ? "Do" : "Up to"} ${formatRecipeDuration(30, locale)}`}</option><option value="60">{`${pl ? "Do" : "Up to"} ${formatRecipeDuration(60, locale)}`}</option></select></label><label><span className="sr-only">{pl ? "Poziom trudności" : "Difficulty"}</span><select value={difficulty} onChange={event => update("difficulty", event.target.value)}><option value="">{pl ? "Dowolny poziom" : "Any difficulty"}</option><option value="easy">{pl ? "Łatwe" : "Easy"}</option><option value="medium">{pl ? "Średnie" : "Medium"}</option></select></label></div>
    </div>}
    {pantryActive && visible.length > 0 && <section className="today-suggestions" aria-labelledby="today-suggestions-title"><h3 id="today-suggestions-title">{pl ? 'Do 3 pomysłów na dziś' : 'Up to 3 ideas for today'}</h3><div>{visible.slice(0, 3).map(recipe => <article key={recipe.id}><Link href={getRecipeHref(recipe, locale)}>{recipe.title[locale]}<RecipeDietBadge recipe={recipe} locale={locale} /><ArrowUpRight size={17} aria-hidden="true" /></Link><ul>{pantryMatchReasons(pantryByRecipe.get(recipe.id)!, locale).map(reason => <li key={reason}>{reason}</li>)}</ul></article>)}</div></section>}
    <div className="catalog-results-label"><p aria-live="polite" role="status">{pantryActive ? pl ? 'Z Twojej lodówki' : 'From your fridge' : onlySaved ? (pl ? "Twoje ulubione" : "Your favourites") : (pl ? "Na dobry początek" : "A delicious place to start")}<span>{visible.length} {pl ? (visible.length === 1 ? "przepis" : visible.length >= 2 && visible.length <= 4 ? "przepisy" : "przepisów") : (visible.length === 1 ? "recipe" : "recipes")}</span></p><span className="catalog-note">{pl ? 'Pomysły na Twój stół' : 'Ideas for your table'}</span></div>
    {visible.length ? <div className="recipe-grid">{visible.map((recipe, index) => <RecipeCard key={recipe.id} recipe={recipe} locale={locale} saved={savedIds.includes(recipe.id)} onSave={() => { toggleSaved(recipe.id); if (!savedIds.includes(recipe.id)) recordUsage('recipe_save', getRecipeHref(recipe, locale)); }} index={index} pantryMatch={pantryActive ? pantryByRecipe.get(recipe.id) : undefined} />)}</div> : <div className="empty-state"><CookingPot size={47} strokeWidth={1.1} /><h3>{onlySaved && !savedIds.length ? (pl ? "Tutaj czekają Twoje ulubione." : "Your favourites will live here.") : (pl ? "Jeszcze nie mamy takiego przepisu." : "No recipes found just yet.")}</h3><p>{onlySaved && !savedIds.length ? (pl ? "Kliknij serduszko przy przepisie, żeby mieć go pod ręką." : "Tap a recipe’s heart to keep it close at hand.") : pantryActive ? pl ? 'Dodaj inne produkty do lodówki albo wybierz mniej filtrów.' : 'Add other ingredients to your fridge or choose fewer filters.' : (pl ? "Spróbuj innego składnika albo wybierz mniej filtrów." : "Try another ingredient or choose fewer filters.")}</p><button type="button" className="primary-button" onClick={clear}>{pl ? "Zobacz wszystkie przepisy" : "See all recipes"}<ArrowUpRight size={19} /></button></div>}
  </>;
}

export function RecipeCard({ recipe, locale, saved, onSave, index, pantryMatch, href: suppliedHref, action, showPopular = true }: { recipe: PublicRecipe; locale: Locale; saved: boolean; onSave: () => void; index: number; pantryMatch?: PantryMatch; href?: string; action?: ReactNode; showPopular?: boolean }) {
  const category = categories.find(item => item.id === recipe.primaryCategory);
  const href = suppliedHref ?? getRecipeHref(recipe, locale);
  const pl = locale === "pl";
  return <article className={`recipe-card card-tint-${index % 6}`}>
    <div className="recipe-card-image"><Link href={href} tabIndex={-1} aria-hidden="true"><RecipeHeroImage src={recipe.image} published alt={recipe.imageAlt[locale]} sizes="(max-width: 460px) calc(100vw - 40px), (max-width: 700px) calc((100vw - 56px) / 2), (max-width: 900px) calc((100vw - 95px) / 2), (max-width: 1100px) calc((100vw - 112px) / 3), min(422px, calc((100vw - 166px) / 3))" maximumWidth={960} className="card-food" surface="card" /></Link><button type="button" className={`save-recipe ${saved ? "is-saved" : ""}`} aria-pressed={saved} aria-label={`${saved ? (pl ? "Usuń z ulubionych" : "Remove from favourites") : (pl ? "Zapisz w ulubionych" : "Save to favourites")}: ${recipe.title[locale]}`} onClick={onSave}><Heart size={20} strokeWidth={1.5} fill={saved ? "currentColor" : "none"} /></button><span className="card-category">{category?.label[locale]}</span><span className="recipe-card-diet"><RecipeDietBadge recipe={recipe} locale={locale} /></span></div>
    <div className="recipe-card-content">{showPopular && isPopularNow(recipe) && <span className="popular-now">{pl ? 'Popularne teraz' : 'Popular now'}</span>}<Link href={href} className="recipe-card-title"><h3>{recipe.title[locale]}</h3><ArrowUpRight size={23} strokeWidth={1.3} aria-hidden="true" /></Link><p className="recipe-card-description">{formatRecipeDurationText(recipe.description[locale], locale)}</p><div className="recipe-card-meta"><span><Clock3 size={15} strokeWidth={1.5} aria-hidden="true" />{formatRecipeDuration(recipe.times.total, locale)}</span><span className="meta-dot" /><span>{recipe.difficulty === "easy" ? (pl ? "Łatwy" : "Easy") : (pl ? "Średni" : "Medium")}</span><span className="card-servings">{formatServingCount(recipe.baseServings, locale)}</span></div>{pantryMatch && <div className="pantry-match-details"><p><strong>{pl ? 'Masz:' : 'You have:'}</strong> {pantryMatch.owned.map(item => item.name[locale]).join(', ')}</p><p><strong>{pantryMatch.missing.length ? pl ? 'Brakuje:' : 'Still needed:' : pl ? 'Wszystkie produkty pod ręką.' : 'All ingredients to hand.'}</strong> {pantryMatch.missing.map(item => item.name[locale]).join(', ')}</p>{pantryMatch.alternatives.length > 0 && <div className="pantry-alternatives"><strong>{pl ? 'Możesz rozważyć zamiennik:' : 'A substitution to consider:'}</strong>{pantryMatch.alternatives.map(item => <p key={item.substitution.id}>{recipe.ingredients.find(ingredient => ingredient.id === item.ingredientId)?.name[locale]} → {item.substitution.name[locale]}. {formatRecipeDurationText(item.substitution.note[locale], locale)}</p>)}</div>}</div>}</div>
    {action === undefined ? <PlanAddButton recipe={recipe} locale={locale} showPlanLink={false} /> : action}
  </article>;
}
