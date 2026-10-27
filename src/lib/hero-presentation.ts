import type { Localised, Recipe, RecipeStep } from './recipes';

/** Versioned independently of the image provider so saved jobs retain their contract. */
export const heroPresentationProfile = 'jesie-finished-dish-v2' as const;
export const heroContainers = ['plate', 'bowl', 'sauceboat', 'jar', 'bottle', 'glass', 'clay-pot', 'pot', 'pan', 'baking-dish', 'platter'] as const;
export type HeroContainer = typeof heroContainers[number];

export interface HeroPresentation {
  container: HeroContainer;
  finalAppearance: Localised;
  evidenceStepIds: string[];
  profileVersion: typeof heroPresentationProfile;
}

type PresentationRecipe = Pick<Recipe, 'title' | 'description' | 'steps' | 'primaryCategory' | 'heroPresentation'>;

export function isGlassHeroPresentation(presentation: HeroPresentation | null | undefined): boolean {
  return presentation?.container === 'jar' || presentation?.container === 'bottle' || presentation?.container === 'glass';
}

export function heroPresentationIssue(recipe: Pick<Recipe, 'steps'>, presentation: HeroPresentation | null | undefined): string | null {
  if (!presentation) return 'Wybierz naczynie i opisz wygląd gotowej potrawy.';
  if (presentation.profileVersion !== heroPresentationProfile || !heroContainers.includes(presentation.container)) return 'Wybierz obsługiwany sposób prezentacji zdjęcia.';
  for (const locale of ['pl', 'en'] as const) {
    if (typeof presentation.finalAppearance?.[locale] !== 'string' || !presentation.finalAppearance[locale].trim()) return `Opisz wygląd gotowej potrawy ${locale.toUpperCase()}.`;
    if (presentation.finalAppearance[locale].length > 600) return `Opis wyglądu ${locale.toUpperCase()} może mieć najwyżej 600 znaków.`;
  }
  if (!Array.isArray(presentation.evidenceStepIds) || presentation.evidenceStepIds.length === 0) return 'Wskaż krok uzasadniający wygląd gotowej potrawy.';
  if (new Set(presentation.evidenceStepIds).size !== presentation.evidenceStepIds.length) return 'Kroki uzasadniające wygląd potrawy nie mogą się powtarzać.';
  const stepIds = new Set(recipe.steps.map(step => step.id));
  if (presentation.evidenceStepIds.some(id => !stepIds.has(id))) return 'Wskazany krok wyglądu potrawy został usunięty. Wybierz aktualny krok.';
  return null;
}

/** Overrides may outlive deleted steps; never silently use such a brief. */
export function isValidHeroPresentation(recipe: Pick<Recipe, 'steps'>, presentation: unknown): presentation is HeroPresentation {
  if (!presentation || typeof presentation !== 'object') return false;
  const value = presentation as Partial<HeroPresentation>;
  if (value.profileVersion !== heroPresentationProfile || !heroContainers.includes(value.container as HeroContainer)) return false;
  if (!value.finalAppearance || !(['pl', 'en'] as const).every(locale => typeof value.finalAppearance?.[locale] === 'string' && value.finalAppearance[locale].trim().length > 0 && value.finalAppearance[locale].length <= 600)) return false;
  if (!Array.isArray(value.evidenceStepIds) || value.evidenceStepIds.length === 0 || new Set(value.evidenceStepIds).size !== value.evidenceStepIds.length) return false;
  const stepIds = new Set(recipe.steps.map(step => step.id));
  return value.evidenceStepIds.every(id => typeof id === 'string' && stepIds.has(id));
}

const vesselPatterns = {
  jar: /\b(?:słoik\p{L}*|słoicz\p{L}*|jars?)\b/iu,
  bottle: /\b(?:butelk\p{L}*|bottles?)\b/iu,
};
const negative = /\b(?:nie|nigdy|unikaj|never|avoid|do not|don't|cannot|must not)\b/iu;
const optional = /\b(?:możesz|można|opcjonalnie|ewentualnie|lub|albo|optionally|optional|if desired|if you wish|or)\b/iu;
const transfer = /\b(?:przełóż|przełoż|przelej|przelan\p{L}*|wlej|wlewan\p{L}*|rozlej|rozdziel|nakładaj|nałóż|układaj|umieść|transfer|pour|divide|pack|spoon|ladle|place)(?!\p{L})[^.!?;]{0,100}\b(?:do|między|w|into|to|between|among|in)\b/iu;
const fill = /\b(?:napełnij|napełnion\p{L}*|zakręć|zamknij|zalej|fill|filled|seal|close)(?!\p{L})/iu;

function clauses(value: string): string[] {
  return value.replace(/\{\{[^}]+\}\}/g, '').split(/[.!?;]+|\n|,\s*(?:ale|but)\s+/iu).map(part => part.trim()).filter(Boolean);
}

function packagingEvidence(steps: RecipeStep[]) {
  const found = new Map<'jar' | 'bottle', Set<string>>();
  let unclear = false;
  let vesselMention = false;
  for (const step of steps) {
    for (const locale of ['pl', 'en'] as const) {
      for (const clause of clauses(`${step.title[locale]}. ${step.text[locale]}`)) {
        for (const container of ['jar', 'bottle'] as const) {
          if (!vesselPatterns[container].test(clause) || negative.test(clause)) continue;
          // Heating, washing and preparing an empty vessel cannot establish the final product.
          const isFilling = fill.test(clause) || transfer.test(clause);
          if (!isFilling && /przechow\p{L}*|\b(?:store|storage|leftovers?|remaining)\b/iu.test(clause)) continue;
          vesselMention = true;
          if (!isFilling) continue;
          if (optional.test(clause)) { unclear = true; continue; }
          if (!found.has(container)) found.set(container, new Set());
          found.get(container)!.add(step.id);
        }
      }
    }
  }
  return { found, unclear: unclear || (found.size === 0 && vesselMention) };
}

function smoothStep(step: RecipeStep): boolean {
  return (['pl', 'en'] as const).some(locale => clauses(`${step.title[locale]}. ${step.text[locale]}`).some(clause => {
    if (negative.test(clause.slice(0, 35))) return false;
    return /\b(?:zmiksuj|miksuj|blenduj|zmiksowan\p{L}*|blend|blended|purée|puree)\b/iu.test(clause)
      && /gład\p{L}*|smooth|no (?:discernible |visible )?pieces|znikn\p{L}*[^.]{0,30}kawał/iu.test(clause);
  }));
}

function standaloneSauceTitle(recipe: PresentationRecipe): boolean {
  const pl = recipe.title.pl.trim();
  const en = recipe.title.en.trim();
  const meal = /\b(?:makaron|tagliatelle|kurczak|chicken|wołowina|beef|wieprzowina|pork|pierogi|dumplings|noodles|ryż|rice|łosoś|salmon|tofu|meatballs?|pulpety|klopsiki|fish|cod|steak|shrimp|prawns?|gnocchi|ravioli)\b/iu;
  if (/^sauce\b/iu.test(en) || /^sos\s/iu.test(pl)) return true;
  if (/^(?:pasta|pizza|barbecue|bbq) sauce$/iu.test(en)) return true;
  if (meal.test(`${pl} ${en}`)) return false;
  return /(?:^|\s)sos(?:\s|$)/iu.test(pl)
    || (/\bsauce$/iu.test(en) && !/\b(?:in|with)\b/iu.test(en));
}

const drinkingGlassPattern = /szklan(?:k\p{L}*|ce|eczk\p{L}*)|kielisz(?:ek|k\p{L}*)|\b(?:drinking glass(?:es)?|wine glass(?:es)?|glasses|goblets?|tumblers?|glass(?!\s+(?:jars?|bottles?|bowls?|plates?|containers?|dishes|jugs?)))\b/iu;
const servingVesselPatterns: ReadonlyArray<readonly [HeroContainer, RegExp]> = [
  ['clay-pot', /glinian\p{L}*\s+(?:garn\p{L}*|naczyn\p{L}*)|(?:clay|earthenware)\s+(?:cooking\s+)?pots?|\b(?:donabe|dolsot|ttukbaegi|tagine|tajine)\b/iu],
  ['baking-dish', /naczyni\p{L}*\s+żaroodporn\p{L}*|brytfann\p{L}*|form\p{L}*\s+do\s+(?:pieczen\p{L}*|zapiek\p{L}*)|\b(?:casserole dish|baking dish|roasting tin)\b/iu],
  ['pan', /pateln\p{L}*|\b(?:pan|skillet)\b/iu],
  ['pot', /garn\p{L}*|\b(?:pot|saucepan)\b/iu],
  ['platter', /półmisk\p{L}*|półmisek|\bplatters?\b/iu],
  ['bowl', /mis(?:k\p{L}*|ce|a|ę)|\bbowls?\b/iu],
  ['plate', /talerz\p{L}*|\bplates?\b/iu],
  ['glass', drinkingGlassPattern],
];
const servingAction = /(?:^|[^\p{L}])(?:podaj|podawaj|serwuj|nałóż|nakładaj|rozłóż|wyłóż|serve|serving|present|plate|arrange)(?!\p{L})|bring[^.!?]{0,30}to (?:the )?table/iu;
const explicitServingAction = /(?:^|[^\p{L}])(?:podaj|podawaj|serwuj|serve|serving|present)(?!\p{L})|bring[^.!?]{0,30}to (?:the )?table/iu;
const platingAction = /(?:^|[^\p{L}])(?:przełóż|wyłóż|ułóż|rozłóż|nałóż|transfer|divide|arrange|spoon|ladle)(?!\p{L})/iu;
const glassPouringAction = /(?:^|[^\p{L}])(?:przelej|rozlej|wlej|pour|divide|ladle)(?!\p{L})/iu;
const glassServingLocation = /\b(?:w|we|do|między|in|into|among|between)\s+(?:(?:mał\p{L}*|schłodzon\p{L}*|szklan\p{L}*|wysok\p{L}*|dwa|dwie|trzy|czter\p{L}*|small|chilled|clear|tall|a|the|one|two|three|four|\d+)\s+){0,4}(?:szklan(?:k\p{L}*|ce|eczk\p{L}*)|kielisz(?:ek|k\p{L}*)|(?:drinking |wine )?glass(?:es)?|goblets?|tumblers?)\b/iu;
const cookingAction = /(?:^|[^\p{L}])(?:gotuj|ugotuj|duś|dusić|piecz|upiecz|smaż|usmaż|zapiecz|cook|simmer|braise|bake|roast|fry)(?!\p{L})/iu;

function vesselInText(text: string): HeroContainer | null {
  return servingVesselPatterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function finalServingVessel(recipe: PresentationRecipe): { container: HeroContainer; stepId: string; index: number } | null {
  let result: ReturnType<typeof finalServingVessel> = null;
  recipe.steps.forEach((step, index) => {
    for (const locale of ['pl', 'en'] as const) {
      for (const clause of clauses(step.text[locale])) {
        if (negative.test(clause) || optional.test(clause)) continue;
        const container = vesselInText(clause);
        if (!container) continue;
        // A glass mentioned as a measure or side drink is not the food vessel.
        if (container === 'glass' && !glassServingLocation.test(clause)) continue;
        const serving = explicitServingAction.test(clause)
          || explicitServingAction.test(step.title[locale]) && (platingAction.test(clause) || container === 'glass' && glassPouringAction.test(clause));
        const plated = ['plate', 'bowl', 'platter'].includes(container) && platingAction.test(clause);
        if (serving || plated) result = { container, stepId: step.id, index };
      }
    }
  });
  return result;
}

/** Cooking equipment becomes the serving vessel only when the dish identifies it. */
function definingCookware(recipe: PresentationRecipe): { container: HeroContainer; stepId: string } | null {
  const titleContainer = vesselInText(`${recipe.title.pl} ${recipe.title.en}`);
  if (!titleContainer || !['clay-pot', 'pot', 'pan', 'baking-dish'].includes(titleContainer)) return null;
  for (const step of [...recipe.steps].reverse()) {
    if ((['pl', 'en'] as const).some(locale => clauses(step.text[locale]).some(clause =>
      !negative.test(clause) && !optional.test(clause) && cookingAction.test(clause)
      && (vesselInText(clause) === titleContainer || titleContainer === 'clay-pot' && vesselInText(clause) === 'pot')))) {
      return { container: titleContainer, stepId: step.id };
    }
  }
  return null;
}

function ambiguousSmoothResult(recipe: PresentationRecipe, smoothSteps: RecipeStep[], wholeProduct: boolean): boolean {
  if (smoothSteps.length === 0) return false;
  // Blending a dressing/sauce in a meal says nothing about the texture of the complete meal.
  if (!wholeProduct) return true;
  const latest = smoothSteps[smoothSteps.length - 1];
  const latestIndex = recipe.steps.findIndex(step => step.id === latest.id);
  const partial = /połow\p{L}*|część|części|trochę|\b(?:half|part of|some of|a portion|reserved|remaining)\b/iu;
  if (partial.test(`${latest.title.pl} ${latest.title.en} ${latest.text.pl} ${latest.text.en}`)) return true;
  const addition = /\b(?:dodaj|wmieszaj|wrzuć|włóż|posyp|udekoruj|add|fold|stir in|top|garnish|sprinkle)(?!\p{L})/iu;
  const solids = /kawał\p{L}*|kostk\p{L}*|plaster\p{L}*|grzank\p{L}*|klops\p{L}*|owoce|warzyw\p{L}*|grzyb\p{L}*|brzoskw\p{L}*|ogór\p{L}*|papryk\p{L}*|gruszk\p{L}*|\b(?:chunks?|pieces?|dice|diced|cubes?|slices?|croutons|croûtons|meatballs|fruit|vegetables?|mushrooms?|berries|peas|beans|peppers|peaches|cucumbers|pears|tofu|salmon|chicken)\b/iu;
  return (['pl', 'en'] as const).some(locale => {
    const latestClauses = clauses(latest.text[locale]);
    let lastBlendingClause = -1;
    latestClauses.forEach((clause, index) => {
      if (smoothStep({ ...latest, title: { pl: '', en: '' }, text: { pl: clause, en: clause } })) lastBlendingClause = index;
    });
    const laterClauses = [
      ...latestClauses.slice(lastBlendingClause + 1),
      ...recipe.steps.slice(latestIndex + 1).flatMap(step => clauses(step.text[locale])),
    ];
    return laterClauses.some(clause => !negative.test(clause) && addition.test(clause) && solids.test(clause));
  });
}

/** New suggestions distinguish allocating liquid from blending only part of a dish. */
function ambiguousSuggestedSmoothResult(recipe: PresentationRecipe, smoothSteps: RecipeStep[], wholeProduct: boolean): boolean {
  if (smoothSteps.length === 0) return false;
  if (!wholeProduct) return true;
  const latest = smoothSteps[smoothSteps.length - 1];
  const partialBlend = /\b(?:zmiksuj|miksuj|blenduj|blend|purée|puree)\s+(?:(?:tylko|jedynie|only|just|the|a)\s+){0,3}(?:połow\p{L}*|część|części|trochę|half|part(?:\s+of)?|some(?:\s+of)?|portion)(?!\p{L})/iu;
  if (partialBlend.test(`${latest.title.pl}. ${latest.title.en}. ${latest.text.pl}. ${latest.text.en}`)) return true;
  // Retain the old conservative solid-addition guard, but remove unrelated
  // fractions such as "add half the water" before calling it. That guard and
  // its original wording remain unchanged for historical identity resolution.
  const withoutAllocation = { ...recipe, steps: recipe.steps.map(step => step.id === latest.id ? {
    ...step,
    title: { pl: step.title.pl.replace(/połow\p{L}*|część|części|trochę/giu, ''), en: step.title.en.replace(/\b(?:half|part of|some of|a portion|reserved|remaining)\b/giu, '') },
    text: { pl: step.text.pl.replace(/połow\p{L}*|część|części|trochę/giu, ''), en: step.text.en.replace(/\b(?:half|part of|some of|a portion|reserved|remaining)\b/giu, '') },
  } : step) };
  return ambiguousSmoothResult(withoutAllocation, withoutAllocation.steps.filter(smoothStep), wholeProduct);
}

function brief(value: string): string {
  const text = value.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= 600) return text;
  const lastSpace = text.lastIndexOf(' ', 599);
  return `${text.slice(0, lastSpace > 450 ? lastSpace : 599).replace(/[ ,;:—-]+$/, '')}…`;
}

function visualMethodDetails(recipe: PresentationRecipe, smoothSteps: RecipeStep[], locale: 'pl' | 'en') {
  const latestBlendIndex = smoothSteps.length ? recipe.steps.findIndex(step => step.id === smoothSteps[smoothSteps.length - 1].id) : 0;
  return recipe.steps.slice(latestBlendIndex).flatMap(step => step.text[locale].replace(/\{\{[^}]+\}\}/g, '').split(/[.!?]+/u)
    .map(text => ({ id: step.id, text: text.trim() })))
    .filter(({ text }) => /powinn\p{L}*|(?:^|\s)mają(?=\s)|should|finished|rumian\p{L}*|golden|crispy|jędrn\p{L}*|aksamit\p{L}*|velvety|hold their shape|remain distinct/iu.test(text))
    .slice(-2);
}

const containerAppearance: Record<HeroContainer, Localised> = {
    plate: { pl: 'Gotowa potrawa na talerzu.', en: 'The finished dish on a plate.' },
    bowl: { pl: 'Gotowa potrawa w misce.', en: 'The finished dish in a bowl.' },
    sauceboat: { pl: 'Gotowy sos w małej ceramicznej sosjerce.', en: 'The finished sauce in a small ceramic sauce boat.' },
    jar: { pl: 'Gotowy przetwór w szklanym słoiku, z zawartością widoczną przez ścianki.', en: 'The finished preserve in a glass jar, with the contents visible through the sides.' },
    bottle: { pl: 'Gotowy produkt w szklanej butelce, z zawartością widoczną przez ścianki.', en: 'The finished product in a glass bottle, with the contents visible through the sides.' },
    glass: { pl: 'Gotowa potrawa w szklance lub kieliszku, z zawartością widoczną przez szklane ścianki.', en: 'The finished food in a drinking glass or goblet, with its contents visible through the glass sides.' },
    'clay-pot': { pl: 'Gotowa potrawa w glinianym garnku.', en: 'The finished dish in a clay pot.' },
    pot: { pl: 'Gotowa potrawa w garnku.', en: 'The finished dish in a cooking pot.' },
    pan: { pl: 'Gotowa potrawa na patelni.', en: 'The finished dish in a frying pan.' },
    'baking-dish': { pl: 'Gotowa potrawa w naczyniu żaroodpornym.', en: 'The finished dish in a baking dish.' },
    platter: { pl: 'Gotowa potrawa na półmisku.', en: 'The finished dish on a serving platter.' },
};

function finalServingDetails(recipe: PresentationRecipe, locale: 'pl' | 'en') {
  return recipe.steps.flatMap(step => clauses(step.text[locale]).map(text => ({ id: step.id, text })))
    .filter(({ text }) => !negative.test(text) && !optional.test(text)
      && !/przechow\p{L}*|\b(?:store|storage|leftovers?)\b/iu.test(text)
      && !/\b(?:until|before|while|ahead of)\s+serving\b/iu.test(text)
      && (servingAction.test(text) || /(?:^|[^\p{L}])(?:udekoruj|posyp|polej|ułóż|połóż|garnish|top|sprinkle|drizzle|finish)(?!\p{L})/iu.test(text)))
    .slice(-3);
}

function finalAppearance(recipe: PresentationRecipe, container: HeroContainer, smoothSteps: RecipeStep[]): Localised {
  const location = containerAppearance[container];
  const texture = smoothSteps.length > 0 ? {
    pl: 'Zmiksowana baza potrawy ma gładką konsystencję; końcowe dodatki zachowują postać opisaną w przepisie.',
    en: 'The blended base has a smooth consistency; final toppings retain the form described in the recipe.',
  } : { pl: '', en: '' };
  const method = recipe.steps.map(step => `${step.title.pl} ${step.title.en} ${step.text.pl} ${step.text.en}`).join(' ');
  const closure = container === 'bottle' && /kork\p{L}*|corks?|stopper/iu.test(method)
    ? { pl: 'Butelka zamknięta korkiem.', en: 'The bottle is closed with a cork.' }
    : container === 'bottle' && /zakrętk\p{L}*|nakrętk\p{L}*|screw[ -]?cap|screw[ -]?top/iu.test(method)
      ? { pl: 'Butelka zamknięta zakrętką.', en: 'The bottle is closed with a screw cap.' }
      : { pl: '', en: '' };
  const sentences = (details: Array<{ text: string }>) => details.length ? `${details.map(detail => detail.text.replace(/[.!?]+$/, '')).join('. ')}.` : '';
  const methodDetail = (locale: 'pl' | 'en') => sentences(visualMethodDetails(recipe, smoothSteps, locale));
  return {
    pl: brief(`${location.pl} ${sentences(finalServingDetails(recipe, 'pl'))} ${texture.pl} ${closure.pl} ${methodDetail('pl')} ${recipe.description.pl}`),
    en: brief(`${location.en} ${sentences(finalServingDetails(recipe, 'en'))} ${texture.en} ${closure.en} ${methodDetail('en')} ${recipe.description.en}`),
  };
}

/** Conservative local fallback for old/manual records. Storage advice is deliberately excluded. */
export function suggestHeroPresentation(recipe: PresentationRecipe): HeroPresentation | null {
  if (recipe.steps.length === 0) return null;
  const packaging = packagingEvidence(recipe.steps);
  const smooth = recipe.steps.filter(smoothStep);
  const title = `${recipe.title.pl} ${recipe.title.en}`;
  const sauce = standaloneSauceTitle(recipe);
  const soup = recipe.primaryCategory === 'soup' || /\b(?:zupa|soup)\b/iu.test(title)
    || /chłodnik\p{L}*|\b(?:soup|gazpacho|ajo blanco)\b/iu.test(`${recipe.description.pl} ${recipe.description.en}`);
  const preserve = /cowboy candy|\b(?:dżem\p{L}*|konfitur\p{L}*|jam|pickles?|preserve\p{L}*)\b|zagrycha ogórk/iu.test(title);
  if (ambiguousSuggestedSmoothResult(recipe, smooth, sauce || soup || preserve)) return null;
  // Final plating of a whole meal outranks earlier packing of a dressing or another component.
  const serving = finalServingVessel(recipe);
  const cookware = definingCookware(recipe);
  const latestPackingIndex = Math.max(-1, ...[...packaging.found.values()].flatMap(ids => [...ids].map(id => recipe.steps.findIndex(step => step.id === id))));
  const platedMeal = !sauce && !preserve && serving !== null && serving.index > latestPackingIndex;
  if (!platedMeal && (packaging.found.size > 1 || packaging.unclear)) return null;
  // A preserve with no explicit packing instruction needs an editor's choice.
  if (packaging.found.size === 0 && preserve) return null;
  const packaged = platedMeal ? undefined : packaging.found.entries().next().value as ['jar' | 'bottle', Set<string>] | undefined;
  const container: HeroContainer = platedMeal ? serving!.container : packaged?.[0] ?? cookware?.container ?? (sauce ? 'sauceboat' : soup ? 'bowl' : 'plate');
  const evidence = new Set<string>(packaged?.[1] ?? []);
  if (platedMeal) evidence.add(serving!.stepId);
  else if (!packaged && cookware) evidence.add(cookware.stepId);
  for (const step of smooth) evidence.add(step.id);
  for (const locale of ['pl', 'en'] as const) {
    for (const detail of visualMethodDetails(recipe, smooth, locale)) evidence.add(detail.id);
    for (const detail of finalServingDetails(recipe, locale)) evidence.add(detail.id);
  }
  // Later steps can be pure serving/storage advice. Keep a real method reference as fallback.
  if (evidence.size === 0) evidence.add(recipe.steps[recipe.steps.length - 1].id);
  return {
    container,
    finalAppearance: finalAppearance(recipe, container, smooth),
    evidenceStepIds: [...evidence],
    profileVersion: heroPresentationProfile,
  };
}

/** Preserve historical inferred photo subjects, approval hashes and accepted job contracts. */
function legacyHeroPresentation(recipe: PresentationRecipe): HeroPresentation | null {
  if (recipe.steps.length === 0) return null;
  const packaging = packagingEvidence(recipe.steps);
  const smooth = recipe.steps.filter(smoothStep);
  const title = `${recipe.title.pl} ${recipe.title.en}`;
  const sauce = standaloneSauceTitle(recipe);
  const soup = recipe.primaryCategory === 'soup' || /\b(?:zupa|soup)\b/iu.test(title);
  const preserve = /cowboy candy|\b(?:dżem\p{L}*|konfitur\p{L}*|jam|pickles?|preserve\p{L}*)\b|zagrycha ogórk/iu.test(title);
  if (ambiguousSmoothResult(recipe, smooth, sauce || soup || preserve)) return null;
  let platingIndex = -1;
  recipe.steps.forEach((step, stepIndex) => {
    if ((['pl', 'en'] as const).some(locale => clauses(step.text[locale]).some(clause => !negative.test(clause)
      && /na (?:talerz\p{L}*|półmis\p{L}*)|on (?:a |the )?(?:plates?|platter)/iu.test(clause)))) platingIndex = stepIndex;
  });
  const latestPackingIndex = Math.max(-1, ...[...packaging.found.values()].flatMap(ids => [...ids].map(id => recipe.steps.findIndex(step => step.id === id))));
  const platedMeal = !sauce && !preserve && platingIndex >= 0 && platingIndex > latestPackingIndex;
  if (!platedMeal && (packaging.found.size > 1 || packaging.unclear)) return null;
  if (packaging.found.size === 0 && preserve) return null;
  const packaged = platedMeal ? undefined : packaging.found.entries().next().value as ['jar' | 'bottle', Set<string>] | undefined;
  const container: HeroContainer = platedMeal ? 'plate' : packaged?.[0] ?? (sauce ? 'sauceboat' : soup ? 'bowl' : 'plate');
  const evidence = new Set<string>(packaged?.[1] ?? []);
  if (platedMeal) evidence.add(recipe.steps[platingIndex].id);
  for (const step of smooth) evidence.add(step.id);
  for (const locale of ['pl', 'en'] as const) for (const detail of visualMethodDetails(recipe, smooth, locale)) evidence.add(detail.id);
  if (evidence.size === 0) evidence.add(recipe.steps[recipe.steps.length - 1].id);
  const texture = smooth.length > 0 ? {
    pl: 'Zawartość zmiksowana na gładko; bez widocznych kawałków owoców lub warzyw.',
    en: 'The contents are blended completely smooth, with no visible pieces of fruit or vegetables.',
  } : { pl: '', en: '' };
  const method = recipe.steps.map(step => `${step.title.pl} ${step.title.en} ${step.text.pl} ${step.text.en}`).join(' ');
  const closure = container === 'bottle' && /kork\p{L}*|corks?|stopper/iu.test(method)
    ? { pl: 'Butelka zamknięta korkiem.', en: 'The bottle is closed with a cork.' }
    : container === 'bottle' && /zakrętk\p{L}*|nakrętk\p{L}*|screw[ -]?cap|screw[ -]?top/iu.test(method)
      ? { pl: 'Butelka zamknięta zakrętką.', en: 'The bottle is closed with a screw cap.' }
      : { pl: '', en: '' };
  const methodDetail = (locale: 'pl' | 'en') => visualMethodDetails(recipe, smooth, locale).map(detail => detail.text).join('. ');
  return {
    container,
    finalAppearance: {
      pl: brief(`${containerAppearance[container].pl} ${texture.pl} ${closure.pl} ${recipe.description.pl} ${methodDetail('pl')}`),
      en: brief(`${containerAppearance[container].en} ${texture.en} ${closure.en} ${recipe.description.en} ${methodDetail('en')}`),
    },
    evidenceStepIds: [...evidence],
    profileVersion: heroPresentationProfile,
  };
}

export function resolveHeroPresentation(recipe: PresentationRecipe): HeroPresentation | null {
  if (recipe.heroPresentation !== undefined) return isValidHeroPresentation(recipe, recipe.heroPresentation) ? recipe.heroPresentation : null;
  return legacyHeroPresentation(recipe);
}

/** A photo brief can choose a vessel without changing the approved recipe content. */
export function resolveHeroPresentationForBrief(recipe: PresentationRecipe, instructions: string): HeroPresentation | null {
  const presentation = recipe.heroPresentation === undefined ? suggestHeroPresentation(recipe) : resolveHeroPresentation(recipe);
  if (!presentation || !instructions.trim()) return presentation;
  let requested: HeroContainer | null = null;
  const choices: ReadonlyArray<readonly [HeroContainer, RegExp]> = [
    ...servingVesselPatterns,
    ['sauceboat', /sosjer\p{L}*|\bsauce[ -]?boats?\b/iu],
    ['jar', vesselPatterns.jar], ['bottle', vesselPatterns.bottle],
  ];
  for (const clause of clauses(instructions)) {
    const matches = choices.flatMap(([container, pattern]) => [...clause.matchAll(new RegExp(pattern.source, 'giu'))]
      .map(match => ({ container, start: match.index, end: match.index + match[0].length })))
      .sort((left, right) => left.start - right.start || right.end - left.end);
    let previousEnd = 0;
    let previousRejected = false;
    for (const match of matches) {
      // A clay pot is one phrase, rather than a clay pot followed by a generic pot.
      if (match.start < previousEnd) continue;
      const before = clause.slice(previousEnd, match.start);
      const rejected: boolean = /(?:^|[^\p{L}])(?:bez|nie|zamiast|no|not|without|instead of|rather than)(?:\s+[\p{L}-]+){0,3}\s*$/iu.test(before)
        || previousRejected && /^\s*(?:i|ani|lub|albo|and|or|nor)\s*$/iu.test(before);
      if (!rejected) requested = match.container;
      previousEnd = match.end;
      previousRejected = rejected;
    }
  }
  if (!requested || requested === presentation.container) return presentation;
  const selected = requested;
  const replaceLocation = (locale: 'pl' | 'en') => {
    let appearance = presentation.finalAppearance[locale];
    for (const location of Object.values(containerAppearance)) appearance = appearance.replace(location[locale], '').trim();
    return brief(`${containerAppearance[selected][locale]} ${appearance}`);
  };
  return { ...presentation, container: requested, finalAppearance: { pl: replaceLocation('pl'), en: replaceLocation('en') } };
}
