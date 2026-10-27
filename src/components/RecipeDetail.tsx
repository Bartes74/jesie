"use client";

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { formatRecipeDuration } from '@/lib/recipe-duration';
import { getStepTimerMinutes } from '@/lib/step-timer-policy';
import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChefHat, Clock3, Heart, Minus, Plus, Printer, RotateCcw, Signal, UsersRound, X } from "lucide-react";
import { useLocalStorage, useSavedRecipes } from "@/lib/browser-storage";
import { categories, getRecipeHref, type Ingredient, type Locale, type UnitSystem } from "@/lib/recipes";
import { formatIngredientAmount, renderStepText } from "@/lib/quantities";
import { getIngredientImage } from "@/lib/recipe-media";
import { presentedStepPhoto } from '@/lib/step-photo-selection';
import { STEP_PHOTO_ASPECT_RATIO } from "@/lib/recipe-photo-layout";
import { RecipePhoto } from "./RecipePhoto";
import { RecipeHeroImage } from './RecipeHeroImage';
import type { PublicRecipe } from "@/lib/recipe-presentation";
import { formatServingCount } from "@/lib/locale-format";
import { formatSubstitutionAmount, isPopularNow } from "@/lib/pantry";
import { recordUsage } from './UsageMetrics';
import { EMPTY_COOKING_PROGRESS, MAX_KITCHEN_NOTE, type CookingProgress } from '@/lib/kitchen-memory';
import { useRecipeCooking } from './useKitchenMemory';
import { CookingStepTimer, KitchenAssist, useCookingClock } from './CookingControls';
import { RecipeShopping } from './RecipeShopping';
import { RecipeFeedback } from './RecipeFeedback';
import { RecipePlanActions } from './RecipePlanActions';
import { RecipeDietBadge } from './RecipeDietBadge';
import { useRecipeShoppingSelection } from './useRecipeShoppingSelection';
import { CollectionSelectButton } from './CollectionSelectButton';
import "./recipe-detail.css";
import "./visual-recipe.css";
import "./kitchen.css";

type Preferences = { servings: number; units: UnitSystem };
function isPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object') return false;
  const preferences = value as Partial<Preferences>;
  return typeof preferences.servings === 'number' && Number.isFinite(preferences.servings) && preferences.servings >= 1 && preferences.servings <= 24 && (preferences.units === 'metric' || preferences.units === 'uk');
}
function subscribeLocation(callback: () => void) {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}
const requestedCookingMode = () => new URLSearchParams(window.location.search).get('cook') === '1';
const serverCookingMode = () => false;

export function RecipeDetail({ recipe, locale, relatedRecipes = [], collections = [], collectionContext }: { recipe: PublicRecipe; locale: Locale; relatedRecipes?: PublicRecipe[]; collections?: { path: string; title: string }[]; collectionContext?: { id: string; path: string; title: string } }) {
  const pl = locale === "pl";
  const ingredientImage = (id: string) => recipe.photos?.ingredients[id] ?? getIngredientImage(recipe.id, id);
  const stepImage = (id: string) => presentedStepPhoto(recipe, id);
  const defaultPreferences = useMemo<Preferences>(() => ({ servings: recipe.baseServings, units: "metric" }), [recipe.baseServings]);
  const [preferences, setPreferences] = useLocalStorage<Preferences>(`zgotuj:recipe-preferences:v1:${recipe.id}`, defaultPreferences, isPreferences);
  const servings = Number.isFinite(preferences.servings) ? Math.max(1, Math.min(24, Math.round(preferences.servings))) : recipe.baseServings;
  const units: UnitSystem = preferences.units === "uk" ? "uk" : "metric";
  const [shoppingSelection, setShoppingSelection] = useRecipeShoppingSelection(recipe.id);
  const cooking = useRecipeCooking(recipe);
  const progress = cooking.session?.progress ?? EMPTY_COOKING_PROGRESS;
  const checkedIngredients = progress.ingredients;
  const checkedSteps = progress.steps;
  const requestedMode = useSyncExternalStore(subscribeLocation, requestedCookingMode, serverCookingMode);
  const [modeOverride, setModeOverride] = useState<boolean | null>(null);
  const kitchenMode = modeOverride ?? requestedMode;
  const [ingredientsOpen, setIngredientsOpen] = useState(false);
  const now = useCookingClock(cooking.session);
  const completed = !cooking.session && cooking.latest?.status === 'completed';
  const focusCookingControls = () => window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#cooking-session button')?.focus());
  const startCooking = (repeat = false) => { cooking.start(repeat); setModeOverride(true); focusCookingControls(); };
  const toggleProgress = (kind: keyof CookingProgress, id: string) => cooking.toggle(kind, id);
  const { savedIds, toggleSaved } = useSavedRecipes();
  const isSaved = savedIds.includes(recipe.id);
  const [pageSize, setPageSize] = useState<"A4" | "Letter">("A4");
  const [printVariant, setPrintVariant] = useState<"illustrated" | "ink" | "text">("illustrated");
  const [printPreparing, setPrintPreparing] = useState(false);
  const [printError, setPrintError] = useState(false);
  const recipeElement = useRef<HTMLElement>(null);
  const printPending = useRef(false);
  const printGeneration = useRef(0);
  const printDialog = useRef<HTMLDialogElement>(null);
  const category = categories.find(item => item.id === recipe.primaryCategory);
  const groups = [...new Set(recipe.ingredients.map(ingredient => ingredient.group[locale]))];
  const substitutions = (recipe.substitutions ?? []).filter(item => item.status === 'approved' && recipe.ingredients.some(ingredient => ingredient.id === item.ingredientId));
  const amount = (ingredient: Ingredient) => formatIngredientAmount(ingredient, recipe.baseServings, servings, units, locale);
  const changeServings = (next: number) => { setPreferences({ servings: Math.max(1, Math.min(24, next)), units }); recordUsage('servings_change'); };
  const print = async () => {
    if (printPending.current) return;
    printPending.current = true;
    recordUsage('print_recipe');
    setPrintPreparing(true);
    setPrintError(false);
    const generation = printGeneration.current;
    let timeout: number | undefined;
    try {
      if (printVariant === "illustrated") {
        const images = Array.from(recipeElement.current?.querySelectorAll<HTMLImageElement>("img") ?? []);
        await Promise.race([
          Promise.all(images.map(image => {
            image.loading = "eager";
            return image.decode();
          })),
          new Promise<never>((_, reject) => {
            timeout = window.setTimeout(() => reject(new Error("Print images unavailable")), 20_000);
          }),
        ]);
      }
      if (generation === printGeneration.current && printDialog.current?.open) {
        printDialog.current.close();
        window.print();
      }
    } catch {
      if (generation === printGeneration.current) setPrintError(true);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      printPending.current = false;
      setPrintPreparing(false);
    }
  };

  return <main ref={recipeElement} id="main" className={`recipe-detail page-width print-${printVariant}${kitchenMode ? " kitchen-mode" : ""}${ingredientsOpen ? " kitchen-ingredients-open" : ""}`}>
    <style media="print">{`@page { size: ${pageSize} portrait; margin: 15mm; }`}</style>
    <nav className="recipe-breadcrumb no-print" aria-label={pl ? 'Ścieżka strony' : 'Breadcrumb'}><Link href={`/${locale}`} className="recipe-back"><ArrowLeft size={18} aria-hidden="true" />jesie.pl</Link><span aria-hidden="true"> / </span><span>{recipe.title[locale]}</span></nav>
    {collectionContext && <p className="collection-context-return no-print"><Link href={`${collectionContext.path}#recipes`}><ArrowLeft size={17} aria-hidden="true" />{pl ? 'Wróć do kolekcji' : 'Back to collection'}: {collectionContext.title}</Link></p>}
    <section className="detail-hero" aria-labelledby="recipe-title">
      <div className="detail-hero-copy">
        <p className="eyebrow">{category?.label[locale]} <span aria-hidden="true">·</span> {recipe.cuisine[locale]}</p>
        {isPopularNow(recipe) && <span className="popular-now">{pl ? 'W trendach' : 'Trending'}</span>}
        <h1 id="recipe-title">{recipe.title[locale]}</h1>
        <p className="detail-diet"><RecipeDietBadge recipe={recipe} locale={locale} showLabel /></p>
        <p className={`recipe-trust-badge${recipe.kitchenVerified === true ? ' is-verified' : ''}`}>{recipe.kitchenVerified === true ? <><Check size={15} aria-hidden="true" />{pl ? 'Sprawdzone w kuchni' : 'Kitchen tested'}</> : <>{pl ? 'Opracowane redakcyjnie' : 'Editorially prepared'}</>}</p>
        <p className="detail-description">{formatRecipeDurationText(recipe.description[locale], locale)}</p>
        {recipe.publication && <p className="publication-byline">{pl ? 'Opracowanie' : 'Editorial'}: <Link href={`/${locale}/o-serwisie`}>{recipe.publication.author}</Link> · <time dateTime={recipe.publication.datePublished}>{new Intl.DateTimeFormat(pl ? 'pl-PL' : 'en-GB', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(new Date(recipe.publication.datePublished))}</time>{recipe.publication.dateModified !== recipe.publication.datePublished && <> · {pl ? 'Aktualizacja' : 'Updated'}: <time dateTime={recipe.publication.dateModified}>{new Intl.DateTimeFormat(pl ? 'pl-PL' : 'en-GB', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(new Date(recipe.publication.dateModified))}</time></>}</p>}
        <div className="detail-meta">
          <span><Clock3 size={19} aria-hidden="true" />{formatRecipeDuration(recipe.times.total, locale)}</span>
          <span><UsersRound size={20} aria-hidden="true" />{formatServingCount(servings, locale)}</span>
          <span><Signal size={19} aria-hidden="true" />{recipe.difficulty === "easy" ? pl ? "Łatwy" : "Easy" : pl ? "Średni" : "Medium"}</span>
        </div>
        <RecipePlanActions recipe={recipe} locale={locale} servings={servings} selection={shoppingSelection} onServingsChange={changeServings} />
        <div className="detail-actions no-print">
          <button type="button" className={`detail-save${isSaved ? " is-saved" : ""}`} aria-pressed={isSaved} onClick={() => { toggleSaved(recipe.id); if (!isSaved) recordUsage('recipe_save'); }}><Heart size={20} fill={isSaved ? "currentColor" : "none"} aria-hidden="true" />{pl ? isSaved ? "W ulubionych" : "Dodaj do ulubionych" : isSaved ? "Saved" : "Save recipe"}</button>
          <button type="button" className="detail-print" onClick={() => printDialog.current?.showModal()}><Printer size={19} aria-hidden="true" />{pl ? "Drukuj / zapisz PDF" : "Print / save PDF"}</button>
        </div>
        {collectionContext && <CollectionSelectButton collection={collectionContext} recipe={recipe} locale={locale} servings={servings} selection={shoppingSelection} />}
      </div>
      <div className="detail-visual">
        <div className="detail-visual-circle" aria-hidden="true" />
        <RecipeHeroImage src={recipe.image} published={Boolean(recipe.publication)} alt={recipe.imageAlt[locale]} loading="eager" fetchPriority="high" sizes="(max-width: 700px) min(450px, calc(92vw - 37px)), (max-width: 1100px) calc(57vw - 50px), min(730px, calc(57vw - 77px))" className="detail-dish" />
      </div>
    </section>

    <section id="cooking-session" className="cooking-session no-print" aria-labelledby="cooking-session-title">
      <div className="cooking-session-heading"><div><p className="eyebrow">{pl ? 'GOTUJ PO SWOJEMU' : 'COOK YOUR WAY'}</p><h2 id="cooking-session-title" tabIndex={-1}>{cooking.session ? pl ? 'Gotowanie w toku' : 'Cooking in progress' : completed ? pl ? 'Danie ugotowane!' : 'You made it!' : pl ? 'Zabierz przepis do kuchni' : 'Take this recipe to the kitchen'}</h2><p>{cooking.session ? `${checkedSteps.length}/${recipe.steps.length} ${pl ? 'kroków. Możesz wrócić do nich później na tym urządzeniu.' : 'steps. Pick up where you left off on this device.'}` : completed ? pl ? 'Zachowaj własną wskazówkę na następny raz.' : 'Keep your own tip for next time.' : pl ? 'Zacznij sesję, żeby odhaczać składniki i kroki oraz uruchamiać minutniki.' : 'Start a session to tick off ingredients and steps and use timers.'}</p></div><ChefHat size={33} aria-hidden="true" /></div>
      {cooking.outdated && <p className="kitchen-version-notice" role="status">{pl ? 'Przepis został zaktualizowany. Poprzednia sesja nie zmieni nowych kroków — rozpocznij gotowanie z aktualną instrukcją.' : 'This recipe has been updated. Your previous session will not tick off the new steps — start with the current method.'}</p>}
      <div className="cooking-session-actions">{cooking.session ? <><button type="button" className="primary-button" onClick={() => setModeOverride(!kitchenMode)}><ChefHat size={18} aria-hidden="true" />{kitchenMode ? pl ? 'Zwykły widok' : 'Standard view' : pl ? 'Wznów w trybie kuchennym' : 'Resume cooking mode'}</button><button type="button" className="kitchen-finish" onClick={() => { cooking.finish(); setModeOverride(false); window.requestAnimationFrame(() => document.getElementById('cooking-session-title')?.focus()); }}><Check size={18} aria-hidden="true" />{pl ? 'Ugotowane' : 'Cooked'}</button></> : <button type="button" className="primary-button" onClick={() => startCooking(completed)}><ChefHat size={18} aria-hidden="true" />{completed ? pl ? 'Ugotuj ponownie' : 'Cook again' : pl ? 'Zaczynam gotować' : 'Start cooking'}</button>}
      {kitchenMode && cooking.session && <span className="kitchen-inline-progress" role="status">{checkedSteps.length}/{recipe.steps.length} {pl ? 'kroków' : 'steps'}</span>}
      {kitchenMode && cooking.session && <button type="button" className="kitchen-ingredients-toggle" aria-expanded={ingredientsOpen} aria-controls="ingredients-section" onClick={() => setIngredientsOpen(value => !value)}>{ingredientsOpen ? pl ? 'Schowaj składniki' : 'Hide ingredients' : pl ? 'Pokaż składniki' : 'Show ingredients'}</button>}</div>
      <KitchenAssist recipe={recipe} locale={locale} session={cooking.session} mode={kitchenMode} now={now} />
    </section>

    <div className="detail-cooking-grid">
      <section id="ingredients-section" className="detail-ingredients" aria-labelledby="ingredients-title">
        <h2 id="ingredients-title">{pl ? "Składniki" : "Ingredients"}</h2>
        <div className="ingredient-controls no-print">
          <div className="servings-control">
            <span id="servings-label">{pl ? "Liczba porcji" : "Servings"}</span>
            <div className="servings-stepper" role="group" aria-labelledby="servings-label">
              <button type="button" onClick={() => changeServings(servings - 1)} disabled={servings === 1} aria-label={pl ? "Mniej porcji" : "Fewer servings"}><Minus size={17} aria-hidden="true" /></button>
              <output aria-live="polite">{servings}</output>
              <button type="button" onClick={() => changeServings(servings + 1)} disabled={servings === 24} aria-label={pl ? "Więcej porcji" : "More servings"}><Plus size={17} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="units-control" role="group" aria-label={pl ? "Jednostki" : "Units"}>
            <button type="button" aria-pressed={units === "metric"} onClick={() => setPreferences({ servings, units: "metric" })}>{pl ? "Metryczne" : "Metric"}</button>
            <button type="button" aria-pressed={units === "uk"} onClick={() => setPreferences({ servings, units: "uk" })}>UK</button>
          </div>
        </div>
        <p className="print-portions">{formatServingCount(servings, locale)} · {units === "metric" ? pl ? "jednostki metryczne" : "metric units" : "UK Imperial"}</p>
        {units === "uk" && <p className="unit-note">{pl ? "UK Imperial: oz i brytyjskie fl oz. Łyżeczka = 5 ml, łyżka = 15 ml." : "UK Imperial: oz and British fl oz. One tsp = 5 ml; one tbsp = 15 ml."}</p>}
        {recipe.scalingNote && <p className="scaling-note">{formatRecipeDurationText(recipe.scalingNote[locale], locale)}</p>}
        <div className="ingredient-groups">
          <a className="ingredient-method-jump no-print" href="#method-title">{pl ? "Przejdź do przygotowania →" : "Jump to the method →"}</a>
          {groups.map(group => <div className="ingredient-group" key={group}>
            {groups.length > 1 && group !== (pl ? "Składniki" : "Ingredients") && <h3>{group}</h3>}
            <ul>{recipe.ingredients.filter(ingredient => ingredient.group[locale] === group).map(ingredient => <li key={ingredient.id} className={checkedIngredients.includes(ingredient.id) ? "ingredient-checked" : ""}>
              <label><input type="checkbox" checked={checkedIngredients.includes(ingredient.id)} disabled={!cooking.session} onChange={() => toggleProgress("ingredients", ingredient.id)} /><RecipePhoto media={ingredientImage(ingredient.id)} locale={locale} className="ingredient-thumb" sizes="80px" legacySizes="320px" maximumWidth={320} decorative /><span className="ingredient-description"><span className="ingredient-name">{ingredient.name[locale]}</span><strong>{amount(ingredient)}</strong>{ingredient.note && <small>{formatRecipeDurationText(ingredient.note[locale], locale)}</small>}</span></label>
            </li>)}</ul>
          </div>)}
        </div>
        {substitutions.length > 0 && <section className="ingredient-substitutions" aria-labelledby="substitutions-title"><h3 id="substitutions-title">{pl ? 'Zamienniki' : 'Substitutions'}</h3><p>{pl ? 'Ilości zamienników są przeliczone na wybraną liczbę porcji.' : 'Substitute amounts are adjusted to your selected servings.'}</p><ul>{substitutions.map(item => {
          const original = recipe.ingredients.find(ingredient => ingredient.id === item.ingredientId)!;
          const replacementAmount = formatSubstitutionAmount(item, recipe.baseServings, servings, units, locale);
          return <li key={item.id}><span>{pl ? 'Zamiast' : 'Instead of'} {original.name[locale]}</span><strong>{replacementAmount ? `${replacementAmount} ` : ''}{item.name[locale]}</strong><p>{formatRecipeDurationText(item.note[locale], locale)}</p></li>;
        })}</ul></section>}
        <RecipeShopping recipe={recipe} locale={locale} servings={servings} units={units} selection={shoppingSelection} setSelection={setShoppingSelection} />
        <div className="equipment-block"><h3>{pl ? "Przyda się" : "You’ll need"}</h3><p>{recipe.equipment[locale].join(" · ")}</p></div>
      </section>

      <section className="detail-method" aria-labelledby="method-title">
        <div className="method-heading"><h2 id="method-title">{pl ? "Przygotowanie" : "Method"}</h2><span className="step-progress no-print">{checkedSteps.filter(id => recipe.steps.some(step => step.id === id)).length}/{recipe.steps.length} {pl ? "kroków" : "steps"}</span></div>
        <ol className="method-steps">{recipe.steps.map((step, index) => { const photo = stepImage(step.id);
          const timerMinutes = getStepTimerMinutes(step); return <li key={step.id} id={`step-${encodeURIComponent(step.id)}`} className={`method-step${checkedSteps.includes(step.id) ? " step-checked" : ""}`}>
          <label className="step-marker"><input type="checkbox" checked={checkedSteps.includes(step.id)} disabled={!cooking.session} onChange={() => toggleProgress("steps", step.id)} aria-label={pl ? `Oznacz krok ${index + 1}: ${step.title[locale]}` : `Mark step ${index + 1}: ${step.title[locale]}`} /><span className="step-number">{(index + 1).toString().padStart(2, "0")}</span>{checkedSteps.includes(step.id) && <span className="step-check"><Check size={21} aria-hidden="true" /></span>}</label>
          <div className="step-content"><h3>{step.title[locale]}</h3><p>{renderStepText(step, recipe, servings, units, locale)}</p>{timerMinutes !== null && <CookingStepTimer stepId={step.id} minutes={timerMinutes} locale={locale} timer={cooking.session?.timers[step.id]} now={now} disabled={!cooking.session} onChange={cooking.setTimer} />}{photo && <figure className="step-figure"><RecipePhoto media={photo} locale={locale} className="step-photo" viewportAspectRatio={STEP_PHOTO_ASPECT_RATIO} sizes="(max-width: 700px) calc(100vw - 40px), (max-width: 900px) calc(58vw - 113px), (max-width: 1100px) calc(60vw - 122px), min(724px, calc(62vw - 164px))" legacySizes="(max-width: 700px) 180vw, 100vw" maximumWidth={1600} /><figcaption>{formatRecipeDurationText(photo.caption?.[locale] ?? '', locale)}</figcaption></figure>}</div>
        </li>; })}</ol>
        <div className="cooking-progress-note no-print"><span>{pl ? "Postęp zapisuje się na tym urządzeniu." : "Your progress stays on this device."}</span>{cooking.session && <button type="button" onClick={() => startCooking(true)}><RotateCcw size={13} aria-hidden="true" />{pl ? "Nowa sesja od początku" : "Start a fresh session"}</button>}</div>
        <section className="kitchen-private-note no-print" aria-labelledby="kitchen-note-title"><h3 id="kitchen-note-title">{pl ? 'Moja notatka na następny raz' : 'My note for next time'}</h3><label className="sr-only" htmlFor="kitchen-note">{pl ? 'Prywatna notatka do przepisu' : 'Your private recipe note'}</label><textarea id="kitchen-note" maxLength={MAX_KITCHEN_NOTE} rows={3} value={cooking.note} onChange={event => cooking.setNote(event.target.value)} placeholder={pl ? 'Co zmienić następnym razem? Co szczególnie się udało?' : 'What would you change next time? What worked well?'} /><p>{pl ? 'Zapisuje się automatycznie tylko w tej przeglądarce. Nie wysyłamy tej notatki do redakcji.' : 'Saved automatically in this browser. This note is not sent to the editors.'} <span>{cooking.note.length}/{MAX_KITCHEN_NOTE}</span></p></section>
        {completed && <RecipeFeedback recipe={recipe} locale={locale} sessionId={cooking.latest?.id} completed /> }
        <div className="recipe-more-info">
          <div className="recipe-tips"><h3>{pl ? "Wskazówki" : "Tips"}</h3><ul>{recipe.tips[locale].map(tip => <li key={tip}>{formatRecipeDurationText(tip, locale)}</li>)}</ul></div>
          <div><h3>{pl ? "Przechowywanie" : "Storage"}</h3><p>{formatRecipeDurationText(recipe.storage[locale], locale)}</p></div>
          <div className="time-breakdown"><h3>{pl ? "Podział czasu" : "Timing"}</h3><p>{pl ? "Praca" : "Hands-on"}: {formatRecipeDuration(recipe.times.active, locale)} · {pl ? "Gotowanie" : "Cooking"}: {formatRecipeDuration(recipe.times.cooking, locale)}{recipe.times.rest > 0 && <> · {pl ? "Odpoczynek" : "Resting"}: {formatRecipeDuration(recipe.times.rest, locale)}</>}</p><p>{pl ? "Czas całkowity uwzględnia czynności wykonywane równolegle. Podane czasy mogą się nakładać." : "The total allows for tasks done in parallel. The individual times can overlap."}</p></div>
        </div>
      </section>
    </div>

    {Boolean(recipe.seo?.questions?.length) && <section className="recipe-questions" aria-labelledby="questions-title"><h2 id="questions-title">{pl ? 'Pytania przy gotowaniu' : 'Cooking questions'}</h2>{recipe.seo!.questions!.map(item => <div key={item.id}><h3>{formatRecipeDurationText(item.question[locale], locale)}</h3><p>{formatRecipeDurationText(item.answer[locale], locale)}</p></div>)}</section>}
    <section className="recipe-connections no-print" aria-labelledby="connections-title"><h2 id="connections-title">{pl ? 'Co jeszcze ugotujesz?' : 'What will you cook next?'}</h2>
      {relatedRecipes.length > 0 && <div className="related-recipe-links">{relatedRecipes.map(item => <Link key={item.id} href={getRecipeHref(item, locale)} className="related-recipe-card">
        <div className="related-recipe-image"><RecipeHeroImage src={item.image} published alt={item.imageAlt[locale]} sizes="(max-width: 700px) calc(100vw - 40px), (max-width: 1000px) calc((100vw - 98px) / 2), (max-width: 1100px) calc((100vw - 124px) / 3), min(423px, calc((100vw - 164px) / 3))" maximumWidth={1280} className="related-recipe-photo" surface="card" /></div>
        <div className="related-recipe-content"><h3>{item.title[locale]}</h3><p>{formatRecipeDurationText(item.description[locale], locale)}</p><div className="related-recipe-meta"><RecipeDietBadge recipe={item} locale={locale} /><span><Clock3 size={14} aria-hidden="true" />{formatRecipeDuration(item.times.total, locale)}</span><span className="related-recipe-cta">{pl ? 'Zobacz przepis' : 'View recipe'}<ArrowUpRight size={16} aria-hidden="true" /></span></div></div>
      </Link>)}</div>}
      {collections.length > 0 && <ul className="recipe-collection-links">{collections.map(item => <li key={item.path}><Link href={item.path}>{item.title}</Link></li>)}</ul>}
      <p className="recipe-guide-links"><Link href={`/${locale}/poradniki/${pl ? 'jak-przeliczac-porcje-przepisu' : 'how-to-adjust-recipe-servings'}`}>{pl ? 'Jak przeliczać porcje' : 'How to adjust servings'}</Link><span aria-hidden="true"> · </span><Link href={`/${locale}/poradniki/${pl ? 'jak-wybrac-obiad-z-tego-co-masz' : 'how-to-choose-dinner-from-your-fridge'}`}>{pl ? 'Obiad z tego, co masz' : 'Dinner from what you have'}</Link></p>
    </section>
    <dialog ref={printDialog} className="print-dialog no-print" aria-labelledby="print-dialog-title" onClose={() => { printGeneration.current += 1; }} onClick={event => { if (event.target === event.currentTarget) printDialog.current?.close(); }}>
      <div className="print-dialog-header"><h2 id="print-dialog-title">{pl ? "Przepis na papierze" : "Your printed recipe"}</h2><button type="button" className="icon-button" onClick={() => printDialog.current?.close()} aria-label={pl ? "Zamknij" : "Close"}><X size={21} aria-hidden="true" /></button></div>
      <p>{pl ? "W oknie drukowania możesz wybrać drukarkę albo „Zapisz jako PDF”." : "Choose a printer or “Save as PDF” in your browser’s print window."}</p>
      <label>{pl ? "Format papieru" : "Paper size"}<select value={pageSize} disabled={printPreparing} onChange={event => setPageSize(event.target.value as "A4" | "Letter")}><option>A4</option><option>Letter</option></select></label>
      <label>{pl ? "Wygląd" : "Style"}<select value={printVariant} disabled={printPreparing} onChange={event => setPrintVariant(event.target.value as "illustrated" | "ink" | "text")}><option value="illustrated">{pl ? "Z ilustracją" : "With illustration"}</option><option value="ink">{pl ? "Oszczędny — szarości" : "Ink-saving — greyscale"}</option><option value="text">{pl ? "Sam tekst" : "Text only"}</option></select></label>
      <p className="print-settings-note">{formatServingCount(servings, locale)} · {units === "metric" ? pl ? "jednostki metryczne" : "metric units" : "UK Imperial"}</p>
      {printError && <p role="alert">{pl ? "Nie udało się przygotować wszystkich zdjęć. Spróbuj ponownie lub wybierz wydruk tekstowy." : "Some photos could not be prepared. Try again or choose text only."}</p>}
      <button type="button" className="primary-button" onClick={print} disabled={printPreparing} aria-busy={printPreparing}><Printer size={17} aria-hidden="true" />{printPreparing ? pl ? "Przygotowuję zdjęcia…" : "Preparing photos…" : pl ? "Otwórz drukowanie" : "Open print window"}</button>
    </dialog>
  </main>;
}
