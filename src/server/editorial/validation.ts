import Decimal from 'decimal.js';
import { z } from 'zod';
import type { EditorialContent, PublicationIssue } from '../../lib/editorial-types';
import { categories, recipes } from '../../lib/recipes';
import { heroContainers, heroPresentationIssue, heroPresentationProfile } from '../../lib/hero-presentation';
import { findRecipeExternalReferences } from '../../lib/recipe-content-policy';
import { lemonPhotoPolicyIssues, type LemonPhotoForm } from '../../lib/citrus-photo-policy';
import { ingredientPhotoPolicyIssues } from '../../lib/ingredient-photo-policy';
import { standaloneIngredientPhotoPaths } from '../../lib/static-ingredient-photos';
import { isStepPhotoRequired } from '../../lib/step-photo-selection';
import { recipePhotoAssignmentIssues } from '../../lib/recipe-photo-evidence';
import { curatedRecipePhotoSources } from '../../lib/curated-recipe-photos';
import { inspectRecipeDiet, type VerifiedIngredientDictionary } from '../../lib/recipe-diet';
import { recipeDietIds } from '../../lib/recipe-diet';

const shortText = z.string().max(500);
const longText = z.string().max(20_000);
const localised = z.object({ pl: longText, en: longText });
const localisedList = z.object({ pl: z.array(longText).max(100), en: z.array(longText).max(100) });
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const amount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string().max(40), approximate: z.boolean().optional() }),
  z.object({ kind: z.literal('range'), min: z.string().max(40), max: z.string().max(40), approximate: z.boolean().optional() }),
  z.object({ kind: z.literal('qualitative'), text: localised }),
]);
const mediaTile = z.object({ src: z.string().max(2_000), columns: z.number().int().min(1).max(20), rows: z.number().int().min(1).max(20), index: z.number().int().min(0).max(399), alt: localised, caption: localised.optional(), aspectRatio: z.number().positive().max(20).optional() });

/** Shape and size limits apply to drafts; editorial completeness is a separate gate. */
export const editorialContentSchema = z.object({
  recipe: z.object({
    id,
    slug: localised,
    title: localised,
    description: localised,
    image: z.string().max(2_000),
    imageAlt: localised,
    heroPresentation: z.object({
      container: z.enum(heroContainers),
      finalAppearance: z.object({ pl: z.string().max(600), en: z.string().max(600) }),
      evidenceStepIds: z.array(id).max(100),
      profileVersion: z.literal(heroPresentationProfile).default(heroPresentationProfile),
    }).nullable().optional(),
    primaryCategory: z.enum(categories.map(category => category.id)),
    categories: z.array(z.enum(categories.map(category => category.id))).max(10),
    dietaryTags: z.array(z.object({ id, label: localised, status: z.literal('to_review') })).max(30),
    diet: z.enum(recipeDietIds).optional(),
    difficulty: z.enum(['easy', 'medium']),
    cuisine: localised,
    baseServings: z.number().min(0).max(10_000),
    times: z.object({ active: z.number().min(0).max(100_000), cooking: z.number().min(0).max(100_000), rest: z.number().min(0).max(100_000), total: z.number().min(0).max(100_000) }),
    ingredients: z.array(z.object({ id, name: localised, amount, unit: z.enum(['g', 'ml', 'count', 'tsp', 'tbsp']).nullable(), scaling: z.enum(['linear', 'fixed']), group: localised, note: localised.optional() })).max(100),
    steps: z.array(z.object({ id, title: localised, text: localised, timerMinutes: z.number().min(0).max(100_000).optional() })).max(100),
    equipment: localisedList,
    tips: localisedList,
    storage: localised,
    scalingNote: localised.optional(),
    collection: z.enum(['author', 'trends']).optional(),
    trendConfirmedAt: z.string().datetime({ offset: true }).optional(),
    substitutions: z.array(z.object({
      id, ingredientId: id, name: localised, note: localised,
      amount: amount.optional(), unit: z.enum(['g', 'ml', 'count', 'tsp', 'tbsp']).nullable().optional(),
      scaling: z.enum(['linear', 'fixed']).optional(), status: z.enum(['to_review', 'approved']),
    })).max(100).optional(),
    provenance: z.object({ type: z.enum(['demo_ai', 'original', 'adapted', 'ai_draft']), label: localised, note: localised, kitchenTested: z.boolean() }),
    featured: z.boolean(),
    seo: z.object({
      title: z.object({ pl: shortText, en: shortText }).optional(),
      description: z.object({ pl: shortText, en: shortText }).optional(),
      keywords: z.object({ pl: z.array(shortText).max(12), en: z.array(shortText).max(12) }).optional(),
      collectionIds: z.array(z.enum(['quick-dinners', 'one-pot', 'pantry', 'seasonal'])).max(4).optional(),
      relatedRecipeIds: z.array(id).max(10).optional(),
      questions: z.array(z.object({ id, question: localised, answer: localised })).max(8).optional(),
    }).optional(),
  }),
  originalText: z.string().max(100_000),
  author: shortText,
  sources: z.array(z.object({ id, title: shortText, url: z.string().max(2_000) })).max(100),
  photos: z.object({ ingredients: z.record(id, mediaTile), steps: z.record(id, mediaTile), omittedSteps: z.record(id, z.object({ signature: z.string().regex(/^[a-f0-9]{16}$/), reason: localised })).optional() }),
  kitchenTest: z.object({ date: z.string().max(10), tester: shortText, notes: longText }).optional(),
});

const heroAssets = new Set([...recipes.map(recipe => recipe.image), ...curatedRecipePhotoSources.filter(source => source.kind === 'hero').map(source => source.src)]);
const ingredientAssets = new Set([1, 2, 3].map(index => `/images/ingredients-${index}.webp`));
const stepAssets = new Map(recipes.map(recipe => [`/images/steps-${recipe.id}.webp`, recipe.steps.length]));
export type RegisteredAssets = ReadonlyMap<string, 'hero' | 'ingredient' | 'step'>;
function validTile(photo: EditorialContent['photos']['ingredients'][string] | undefined, kind: 'ingredient' | 'step', registered: RegisteredAssets) {
  if (!photo || photo.index < 0 || photo.index >= photo.columns * photo.rows) return false;
  if (registered.get(photo.src) === kind) return photo.columns === 1 && photo.rows === 1 && photo.index === 0;
  if (kind === 'ingredient' && standaloneIngredientPhotoPaths.includes(photo.src)) return photo.columns === 1 && photo.rows === 1 && photo.index === 0;
  if (kind === 'ingredient') return ingredientAssets.has(photo.src) && photo.columns === 4 && photo.rows === 3;
  if (curatedRecipePhotoSources.some(source => source.kind === 'step' && source.src === photo.src)) return photo.columns === 1 && photo.rows === 1 && photo.index === 0;
  return stepAssets.has(photo.src) && photo.columns === 2 && photo.rows === 3 && photo.index < stepAssets.get(photo.src)!;
}

function validPositive(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  try { const amount = new Decimal(value); return amount.isFinite() && amount.gt(0); } catch { return false; }
}

export function publicationIssues(content: EditorialContent, registered: RegisteredAssets = new Map(), knownLemonSources?: ReadonlyMap<string, LemonPhotoForm>, verifiedAliases?: VerifiedIngredientDictionary): PublicationIssue[] {
  const recipe = content.recipe;
  const issues: PublicationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  if (recipe.diet) {
    const dietary = inspectRecipeDiet(recipe, verifiedAliases);
    if (!dietary.inferredDiet) for (const item of dietary.uncertainIngredients) add(`ingredients.${item.ingredientId}.name`, 'Doprecyzuj podstawowy skład produktu przed przypisaniem kategorii dania.');
    for (const item of dietary.issues) add(item.field, item.message);
  }
  issues.push(...recipePhotoAssignmentIssues(content));
  for (const issue of findRecipeExternalReferences({ recipe, photos: content.photos })) {
    add(issue.path.replace(/^recipe\./, ''), issue.reason);
  }
  for (const issue of lemonPhotoPolicyIssues(recipe.ingredients, content.photos.ingredients, knownLemonSources)) add(`ingredients.${issue.ingredientId}.photo`, issue.message);
  for (const issue of ingredientPhotoPolicyIssues(recipe.ingredients, content.photos.ingredients)) {
    const field = `ingredients.${issue.ingredientId}.photo`;
    if (!issues.some(existing => existing.field === field && existing.message === issue.message)) add(field, issue.message);
  }
  for (const locale of ['pl', 'en'] as const) {
    if (!recipe.title[locale].trim()) add(`title.${locale}`, `Uzupełnij tytuł ${locale.toUpperCase()}.`);
    if (!recipe.description[locale].trim()) add(`description.${locale}`, `Uzupełnij opis ${locale.toUpperCase()}.`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.slug[locale])) add(`slug.${locale}`, `Adres ${locale.toUpperCase()} może zawierać małe litery, cyfry i myślniki.`);
    if (!recipe.imageAlt[locale].trim()) add(`imageAlt.${locale}`, `Uzupełnij opis głównej fotografii ${locale.toUpperCase()}.`);
  }
  if (!content.author.trim()) add('author', 'Podaj autora opracowania.');
  if (recipe.baseServings <= 0) add('baseServings', 'Liczba porcji musi być dodatnia.');
  if (recipe.categories.length === 0 || !recipe.categories.includes(recipe.primaryCategory)) add('categories', 'Wybierz co najmniej jedną kategorię i zaznacz wśród nich kategorię główną.');
  if (new Set(recipe.categories).size !== recipe.categories.length) add('categories', 'Kategorie nie mogą się powtarzać.');
  if (recipe.times.total < Math.max(recipe.times.active, recipe.times.cooking, recipe.times.rest)) add('times.total', 'Czas całkowity jest krótszy od jednego z etapów.');
  if (!heroAssets.has(recipe.image) && registered.get(recipe.image) !== 'hero') add('image', 'Wybierz gotową główną fotografię we własnej bibliotece.');
  if (recipe.ingredients.length === 0) add('ingredients', 'Dodaj przynajmniej jeden składnik.');
  if (recipe.steps.length === 0) add('steps', 'Dodaj przynajmniej jeden krok.');
  const ingredientIds = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const field = `ingredients.${ingredient.id}`;
    if (ingredientIds.has(ingredient.id)) add(field, 'Identyfikator składnika się powtarza.');
    ingredientIds.add(ingredient.id);
    for (const locale of ['pl', 'en'] as const) if (!ingredient.name[locale].trim()) add(`${field}.${locale}`, `Uzupełnij nazwę składnika ${locale.toUpperCase()}.`);
    if (ingredient.amount.kind === 'exact' && !validPositive(ingredient.amount.value)) add(`${field}.amount`, 'Podaj dodatnią ilość w zapisie dziesiętnym.');
    if (ingredient.amount.kind === 'range' && (!validPositive(ingredient.amount.min) || !validPositive(ingredient.amount.max) || (validPositive(ingredient.amount.min) && validPositive(ingredient.amount.max) && new Decimal(ingredient.amount.min).gt(ingredient.amount.max)))) add(`${field}.amount`, 'Zakres ilości musi być dodatni i uporządkowany.');
    if (ingredient.amount.kind === 'qualitative') {
      for (const locale of ['pl', 'en'] as const) if (!ingredient.amount.text[locale].trim()) add(`${field}.amount.${locale}`, 'Uzupełnij opis ilości.');
      if (ingredient.unit !== null) add(`${field}.unit`, 'Opisowa ilość nie może mieć jednostki liczbowej.');
    } else if (ingredient.unit === null) add(`${field}.unit`, 'Wybierz jednostkę ilości.');
    const photo = content.photos.ingredients[ingredient.id];
    if (!validTile(photo, 'ingredient', registered)) add(`${field}.photo`, 'Wybierz fotografię składnika.');
    else for (const locale of ['pl', 'en'] as const) if (!photo.alt[locale].trim()) add(`${field}.photo.${locale}`, 'Uzupełnij opis fotografii składnika.');
  }
  const stepIds = new Set<string>();
  const substitutionIds = new Set<string>();
  for (const substitution of recipe.substitutions ?? []) {
    const field = `substitutions.${substitution.id}`;
    if (substitutionIds.has(substitution.id)) add(field, 'Identyfikator zamiennika się powtarza.');
    substitutionIds.add(substitution.id);
    if (!ingredientIds.has(substitution.ingredientId)) add(field, 'Zamiennik dotyczy usuniętego lub nieznanego składnika.');
    if (substitution.status !== 'approved') continue;
    for (const locale of ['pl', 'en'] as const) {
      if (!substitution.name[locale].trim() || !substitution.note[locale].trim()) add(`${field}.${locale}`, 'Uzupełnij nazwę zamiennika i wskazówkę w obu językach.');
    }
    const alternative = substitution.amount;
    if (alternative?.kind === 'exact' && !validPositive(alternative.value)) add(`${field}.amount`, 'Podaj dodatnią ilość zamiennika.');
    if (alternative?.kind === 'range' && (!validPositive(alternative.min) || !validPositive(alternative.max) || (validPositive(alternative.min) && validPositive(alternative.max) && new Decimal(alternative.min).gt(alternative.max)))) add(`${field}.amount`, 'Zakres ilości zamiennika musi być dodatni i uporządkowany.');
    if (alternative && alternative.kind !== 'qualitative' && !substitution.unit) add(`${field}.unit`, 'Wybierz jednostkę ilości zamiennika.');
    if (alternative?.kind === 'qualitative') {
      if (substitution.unit != null) add(`${field}.unit`, 'Opisowa ilość zamiennika nie może mieć jednostki liczbowej.');
      for (const locale of ['pl', 'en'] as const) if (!alternative.text[locale].trim()) add(`${field}.amount.${locale}`, 'Uzupełnij opis ilości zamiennika w obu językach.');
    }
    if (!alternative && substitution.unit != null) add(`${field}.unit`, 'Jednostka zamiennika wymaga podania ilości.');
  }
  for (const step of recipe.steps) {
    const field = `steps.${step.id}`;
    if (stepIds.has(step.id)) add(field, 'Identyfikator kroku się powtarza.');
    stepIds.add(step.id);
    for (const locale of ['pl', 'en'] as const) {
      if (!step.title[locale].trim() || !step.text[locale].trim()) add(`${field}.${locale}`, `Uzupełnij tytuł i treść kroku ${locale.toUpperCase()}.`);
      for (const token of step.text[locale].matchAll(/\{\{([^}]+)\}\}/g)) if (!ingredientIds.has(token[1])) add(`${field}.${locale}`, `Odwołanie do nieznanego składnika: ${token[1]}.`);
    }
    const plTokens = [...step.text.pl.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort().join('|');
    const enTokens = [...step.text.en.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort().join('|');
    if (plTokens !== enTokens) add(field, 'Odwołania do ilości składników różnią się między PL i EN.');
    const photo = content.photos.steps[step.id];
    if ((!photo && isStepPhotoRequired(content, step.id)) || photo && !validTile(photo, 'step', registered)) add(`${field}.photo`, 'Wybierz fotografię najważniejszego detalu kroku.');
    else if (photo) for (const locale of ['pl', 'en'] as const) if (!photo.alt[locale].trim() || !photo.caption?.[locale].trim()) add(`${field}.photo.${locale}`, 'Uzupełnij opis i wskazówkę przy fotografii kroku.');
  }
  if (recipe.heroPresentation !== undefined) {
    const issue = heroPresentationIssue(recipe, recipe.heroPresentation);
    if (issue) add('heroPresentation', issue);
  }
  for (const source of content.sources) {
    try { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol) || !source.title.trim()) add(`sources.${source.id}`, 'Źródło wymaga tytułu i adresu HTTP/HTTPS.'); } catch { add(`sources.${source.id}`, 'Źródło wymaga poprawnego adresu.'); }
  }
  if (!recipe.provenance.label.pl.trim() || !recipe.provenance.label.en.trim() || !recipe.provenance.note.pl.trim() || !recipe.provenance.note.en.trim()) add('provenance', 'Opisz pochodzenie przepisu w obu językach.');
  if (recipe.provenance.kitchenTested) {
    const kitchen = content.kitchenTest;
    const validDate = kitchen && /^\d{4}-\d{2}-\d{2}$/.test(kitchen.date)
      && !Number.isNaN(Date.parse(`${kitchen.date}T00:00:00Z`))
      && new Date(`${kitchen.date}T00:00:00Z`).toISOString().slice(0, 10) === kitchen.date;
    if (!validDate || !kitchen?.tester.trim() || !kitchen.notes.trim())
      add('provenance.kitchenTested', 'Sprawdzenie w kuchni wymaga prawidłowej daty, osoby i opisu wyniku testu.');
  }
  for (const question of recipe.seo?.questions ?? []) {
    for (const locale of ['pl', 'en'] as const) {
      if (!question.question[locale].trim() || !question.answer[locale].trim())
        add(`seo.questions.${question.id}.${locale}`, 'Uzupełnij pytanie i odpowiedź w obu językach.');
    }
  }
  if (recipe.seo?.relatedRecipeIds?.includes(recipe.id)) add('seo.relatedRecipeIds', 'Przepis nie może wskazywać samego siebie jako powiązanego dania.');
  return issues;
}
