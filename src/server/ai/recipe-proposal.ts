import { z } from 'zod';
import type { EditorialContent } from '@/lib/editorial-types';
import { categories } from '@/lib/recipes';
import { findRecipeExternalReferences } from '@/lib/recipe-content-policy';
import { editorialContentSchema, publicationIssues } from '@/server/editorial/validation';
import { ProviderError, type ProviderIssue } from './provider-error';
import { heroContainers, heroPresentationProfile, isValidHeroPresentation, type HeroPresentation } from '../../lib/hero-presentation';
import { getStepTimerMinutes, maxStepTimerMinutes, stepTimerIssue } from '../../lib/step-timer-policy';
import { inspectRecipeTimingPlan, recipeTimingPlanSchema, recipeTimingVersion, type RecipeTimingPlan } from '../../lib/recipe-timing-plan';
import { explicitStepWaitMinimum, plannedStepRestMinutes } from '../../lib/recipe-timing-evidence';
import { classifyRecipeDiet, inspectRecipeDiet, type VerifiedIngredientDictionary } from '../../lib/recipe-diet';
import { recipeIssuesAllowAutomaticRepair } from './recipe-recovery-policy';
import { recipeDietVersion } from './recipe-diet-instructions';

const localised = z.object({ pl: z.string(), en: z.string() }).strict();
const localisedList = z.object({ pl: z.array(z.string()), en: z.array(z.string()) }).strict();
// The disjoint kind literals preserve the variant contract while emitting
// anyOf, which is supported by OpenAI Structured Outputs.
const amount = z.union([
  z.object({ kind: z.literal('exact'), value: z.string(), approximate: z.boolean() }).strict(),
  z.object({ kind: z.literal('range'), min: z.string(), max: z.string(), approximate: z.boolean() }).strict(),
  z.object({ kind: z.literal('qualitative'), text: localised }).strict(),
]);

export const legacyRecipeProposalSchema = z.object({
  slug: localised, title: localised, description: localised,
  primaryCategory: z.enum(categories.map(category => category.id)),
  categories: z.array(z.enum(categories.map(category => category.id))),
  difficulty: z.enum(['easy', 'medium']), cuisine: localised,
  baseServings: z.number(),
  times: z.object({ active: z.number(), cooking: z.number(), rest: z.number(), total: z.number() }).strict()
    .describe('All numeric durations remain in minutes, including overnight or multi-day rest and total times. Values may exceed 1440 minutes; never replace minutes with an hours value or cap the recipe at one day.'),
  ingredients: z.array(z.object({ id: z.string(), name: localised, amount,
    unit: z.enum(['g', 'ml', 'count', 'tsp', 'tbsp']).nullable(),
    scaling: z.enum(['linear', 'fixed']), group: localised, note: localised.nullable() }).strict()),
  steps: z.array(z.object({
    id: z.string(), title: localised,
    text: localised.describe('One coherent cooking stage in PL and British English. Include the action, necessary conditions, useful timing and its start, and an observable completion cue where judgement is needed. State when parallel work may begin and check readiness before combining. Keep related small actions together; separate independently controlled processes and waits.'),
    timerMinutes: z.number().nullable().describe(`Optional timer for one clearly identified continuous interval in this step, at most ${maxStepTimerMinutes} minutes. Never sum separate waits or represent different parallel processes with one timer. The text names its start and the readiness check. Use null for overnight/day waits or intervals beyond this limit; preserve their complete duration in prose and recipe times. Useful bounded cooking, resting or chilling timers, including a 4-hour chill, remain allowed; null if one meaningful timer cannot represent the stage.`),
  }).strict()).describe('All stages needed by the actual method, in execution order. No editorial target or small maximum count; simple dishes remain concise and complex dishes retain every independently controlled stage.'),
  equipment: localisedList, tips: localisedList, storage: localised,
  scalingNote: localised.nullable(), notes: z.array(z.string()),
  substitutions: z.array(z.object({
    id: z.string(), ingredientId: z.string(), name: localised, note: localised,
    amount: amount.nullable(), unit: z.enum(['g', 'ml', 'count', 'tsp', 'tbsp']).nullable(),
    scaling: z.enum(['linear', 'fixed']),
  }).strict()),
}).strict();

export const recipeProposalVersion = 'finished-dish-v2';
/** New admissions require the presentation in the same recipe response; old receipts keep their nullable schema. */
export const recipePresentationVersion = 'required-finished-dish-v1';
export const recipeResearchVersion = 'web-recipe-v1';
export const recipeResearchSourcesSchema = z.array(z.object({ title: z.string().min(1).max(250), url: z.string().min(1).max(2000) }).strict()).min(1).max(6);
export const recipeProposalSchema = legacyRecipeProposalSchema.extend({
  heroPresentation: z.object({
    container: z.enum(heroContainers),
    finalAppearance: z.object({ pl: z.string().max(600), en: z.string().max(600) }).strict(),
    evidenceStepIds: z.array(z.string()).max(100),
  }).strict().nullable(),
}).strict();

function recipePayloadSchema(input: EditorialContent) {
  const current = input.aiPhotography?.recipeProposalVersion === recipeProposalVersion;
  const schema = current ? input.aiPhotography?.recipePresentationVersion === recipePresentationVersion
    ? recipeProposalSchema.extend({ heroPresentation: recipeProposalSchema.shape.heroPresentation.unwrap() }) : recipeProposalSchema
    : legacyRecipeProposalSchema;
  return input.aiPhotography?.recipeTimingVersion === recipeTimingVersion ? schema.extend({ timingPlan: recipeTimingPlanSchema }) : schema;
}

export function capturedRecipeProposalSchema(input: EditorialContent) {
  const schema = recipePayloadSchema(input);
  return input.aiPhotography?.recipeResearchVersion === recipeResearchVersion ? schema.extend({ researchSources: recipeResearchSourcesSchema }) : schema;
}

const fractions: Record<string, string> = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
function decimalAmount(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim().replace(/[½¼¾⅛⅜⅝⅞]/g, glyph => ` ${fractions[glyph]}`).replace(/⁄/g, '/').trim();
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return text.replace(',', '.');
  const match = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!match || text.length > 100) return value.trim();
  let numerator = BigInt(match[2]); let denominator = BigInt(match[3]);
  if (!denominator || !numerator) return value.trim();
  numerator += BigInt(match[1] ?? '0') * denominator;
  let a = numerator; let b = denominator;
  while (b) { const next = a % b; a = b; b = next; }
  numerator /= a; denominator /= a;
  let reduced = denominator;
  for (const factor of [BigInt(2), BigInt(5)]) while (reduced % factor === BigInt(0)) reduced /= factor;
  if (reduced !== BigInt(1)) return value.trim(); // Never round a recurring fraction or change its quantity.
  let result = String(numerator / denominator); let remainder = numerator % denominator;
  if (remainder) result += '.';
  while (remainder && result.length <= 40) { remainder *= BigInt(10); result += String(remainder / denominator); remainder %= denominator; }
  return remainder || result.length > 40 ? value.trim() : result;
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function trimStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimStrings);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimStrings(item)]));
  return value;
}

/** Repairs representation only. Missing food facts, contradictory quantities and ambiguous IDs stay invalid. */
export function normalizeRecipeProposal(raw: unknown): unknown {
  const result = trimStrings(raw);
  if (!object(result)) return result;
  if (object(result.slug)) for (const locale of ['pl', 'en']) if (typeof result.slug[locale] === 'string') {
    result.slug[locale] = result.slug[locale].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  for (const field of ['ingredients', 'substitutions']) if (Array.isArray(result[field])) for (const item of result[field]) {
    if (!object(item) || !object(item.amount)) continue;
    if (item.amount.kind === 'exact') item.amount.value = decimalAmount(item.amount.value);
    if (item.amount.kind === 'range') { item.amount.min = decimalAmount(item.amount.min); item.amount.max = decimalAmount(item.amount.max); }
  }
  // These duplicates carry no additional category information. Ingredients and steps are never removed.
  if (Array.isArray(result.categories)) result.categories = [...new Set(result.categories)];
  const ingredientIds = new Map<string, string>(); const stepIds = new Map<string, string>();
  for (const [field, ids] of [['ingredients', ingredientIds], ['steps', stepIds]] as const) {
    const items = result[field]; if (!Array.isArray(items)) continue;
    const candidates = items.filter(object).map(item => ({ item, old: item.id, next: typeof item.id === 'string'
      ? item.id.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/\s+/g, '_') : null }));
    const names = candidates.map(candidate => candidate.next);
    if (names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name)) || new Set(names).size !== names.length) continue;
    for (const candidate of candidates) { ids.set(candidate.old as string, candidate.next!); candidate.item.id = candidate.next; }
  }
  if (Array.isArray(result.steps)) for (const step of result.steps) if (object(step) && object(step.text)) {
    for (const locale of ['pl', 'en']) if (typeof step.text[locale] === 'string') step.text[locale] = step.text[locale].replace(/\{\{([^}]+)\}\}/g, (token, id: string) => {
      const replacement = ingredientIds.get(id) ?? ingredientIds.get(id.trim()); return replacement ? `{{${replacement}}}` : token;
    });
  }
  if (Array.isArray(result.substitutions)) for (const item of result.substitutions) if (object(item) && typeof item.ingredientId === 'string' && ingredientIds.has(item.ingredientId)) item.ingredientId = ingredientIds.get(item.ingredientId);
  if (object(result.heroPresentation) && Array.isArray(result.heroPresentation.evidenceStepIds)) result.heroPresentation.evidenceStepIds = result.heroPresentation.evidenceStepIds.map(id => typeof id === 'string' ? stepIds.get(id) ?? id : id);
  if (object(result.timingPlan)) for (const field of ['tasks', 'excludedSteps']) if (Array.isArray(result.timingPlan[field])) {
    for (const item of result.timingPlan[field]) if (object(item) && typeof item.stepId === 'string') item.stepId = stepIds.get(item.stepId) ?? item.stepId;
  }
  return result;
}

function resultInvalid(issues: ProviderIssue[]): never {
  const repairable = recipeIssuesAllowAutomaticRepair(issues);
  throw new ProviderError('AI_RESULT_INVALID', repairable
    ? 'Wynik wymaga poprawy wskazanych pól przed zapisaniem.'
    : 'Aplikacja nie rozpoznaje składnika potrzebnego do klasyfikacji dania. Zachowano wynik; automatyczne płatne poprawki są wstrzymane.',
  false, undefined, { issues, repairable });
}

function parsedProposal(raw: unknown, original: EditorialContent) {
  const parsed = recipePayloadSchema(original).safeParse(normalizeRecipeProposal(raw));
  if (!parsed.success) resultInvalid(parsed.error.issues.map(issue => ({ field: issue.path.join('.') || 'recipe', message: issue.message })));
  return parsed.data;
}

export function recipeProposalIssues(raw: unknown, original: EditorialContent, verifiedAliases?: VerifiedIngredientDictionary): ProviderIssue[] {
  try { buildRecipeProposal(raw, original, verifiedAliases); return []; }
  catch (error) { if (error instanceof ProviderError) return error.issues; throw error; }
}

export function buildRecipeProposal(raw: unknown, original: EditorialContent, verifiedAliases?: VerifiedIngredientDictionary) {
  const current = original.aiPhotography?.recipeProposalVersion === recipeProposalVersion;
  const proposal = parsedProposal(raw, original) as z.infer<typeof legacyRecipeProposalSchema> & { heroPresentation?: z.infer<typeof recipeProposalSchema>['heroPresentation']; timingPlan?: RecipeTimingPlan };
  const planned = original.aiPhotography?.recipeTimingVersion === recipeTimingVersion;
  if (planned) {
    const checked = inspectRecipeTimingPlan(proposal.timingPlan, { steps: proposal.steps.map(step => ({ ...step, timerMinutes: step.timerMinutes ?? undefined })), times: proposal.times });
    if (checked.issues.length) resultInvalid(checked.issues);
    const plan = proposal.timingPlan!;
    const waits = proposal.steps.flatMap(step => {
      if (plan.excludedSteps.some(excluded => excluded.stepId === step.id)) return [];
      const minimum = explicitStepWaitMinimum(step);
      return plannedStepRestMinutes(plan.tasks, step.id) + 1e-8 >= minimum ? [] : [{ field: `timingPlan.tasks`,
        message: `Krok ${step.id} wymaga w instrukcji co najmniej ${minimum} min oczekiwania. Uwzględnij je w zadaniach odpoczynku i pełnym czasie, zachowując treść, warunki i oba języki. Nie zastępuj obowiązkowego oczekiwania terminem przechowywania ani nie usuwaj instrukcji, aby skrócić plan.` }];
    });
    if (waits.length) resultInvalid(waits);
  }
  const timerIssues = proposal.steps.flatMap(step => {
    if (step.timerMinutes === null) return [];
    const candidate = { ...step, timerMinutes: step.timerMinutes };
    return getStepTimerMinutes(candidate) === step.timerMinutes ? [] : [{ field: `steps.${step.id}.timerMinutes`,
      message: `${stepTimerIssue(candidate) ?? `Minutnik musi określać jeden etap od 1 do ${maxStepTimerMinutes} minut.`} Ustaw null dla długiego oczekiwania. Zachowaj pełny czas w instrukcji obu języków oraz w rest i total, zapisanych w minutach; nie skracaj przepisu.` }];
  });
  if (timerIssues.length) resultInvalid(timerIssues);
  const currentProposal = current ? proposal as z.infer<typeof recipeProposalSchema> : null;
  const { notes, timingPlan, ...fields } = proposal;
  const presentation: HeroPresentation | null | undefined = currentProposal
    ? currentProposal.heroPresentation ? { ...currentProposal.heroPresentation, profileVersion: heroPresentationProfile } : null
    : undefined;
  const content: EditorialContent = {
    ...structuredClone(original),
    recipe: {
      ...structuredClone(original.recipe), ...fields,
      id: original.recipe.id, featured: original.recipe.featured,
      diet: classifyRecipeDiet({ ingredients: proposal.ingredients.map(ingredient => ({ ...ingredient, note: ingredient.note ?? undefined })) }, verifiedAliases),
      // A changed method never inherits a previous photograph's final-state claim.
      heroPresentation: current ? presentation : undefined,
      ingredients: proposal.ingredients.map(ingredient => ({ ...ingredient, note: ingredient.note ?? undefined })),
      steps: proposal.steps.map(step => ({ ...step, timerMinutes: step.timerMinutes ?? undefined })),
      scalingNote: proposal.scalingNote ?? undefined,
      substitutions: proposal.substitutions.map(item => ({
        ...item, amount: item.amount ?? undefined,
        unit: item.amount ? item.unit : undefined, status: 'to_review' as const,
      })),
      dietaryTags: [],
      provenance: {
        type: 'ai_draft', kitchenTested: false,
        label: { pl: 'Opracowanie redakcyjne', en: 'Editorial draft' },
        note: { pl: 'Propozycja oczekująca na przegląd redakcyjny.', en: 'A proposal awaiting editorial review.' },
      },
    },
  };
  // Legacy receipts with ambiguous compounds remain readable under their
  // captured contract; new jobs must resolve them before saving a category.
  if (!inspectRecipeDiet({ ingredients: content.recipe.ingredients }, verifiedAliases).inferredDiet) delete content.recipe.diet;
  if (original.aiPhotography?.recipeDietVersion === recipeDietVersion) {
    const dietary = inspectRecipeDiet(content.recipe, verifiedAliases);
    const target = original.aiPhotography.recipeDietTarget;
    const issues: ProviderIssue[] = [];
    if (!dietary.inferredDiet) issues.push(...dietary.uncertainIngredients.map(item => ({
      field: `ingredients.${item.ingredientId}.name`,
      ...(item.kind === 'unrecognised-ingredient' ? { code: 'DIET_INGREDIENT_UNRECOGNISED' } : {}),
      message: item.kind === 'unrecognised-ingredient'
        ? 'Słownik klasyfikacji dietetycznej aplikacji nie rozpoznaje tego składnika. Uzupełnij słownik aplikacji, zachowując składnik i treść przepisu. Nowa płatna generacja nie naprawi brakującej definicji.'
        : `Doprecyzuj rzeczywisty podstawowy skład produktu, aby można było przypisać kategorię dania. ${item.reason} Zachowaj zamysł i składniki przepisu; nie usuwaj produktu ani nie dodawaj deklaracji bez potwierdzenia.`,
    })));
    if (target && dietary.inferredDiet && dietary.inferredDiet !== target) issues.push({ field: 'diet',
      message: `Wybrano danie z kategorii ${target}, ale podstawowe składniki wskazują ${dietary.inferredDiet}. Sprawdź pełny skład, także sosy i dodatki. Nie zmieniaj etykiety, nie usuwaj składników i nie zmieniaj charakteru dania, aby ominąć kontrolę.` });
    if (issues.length) resultInvalid(issues);
  }
  const externalReferences = findRecipeExternalReferences(content.recipe);
  if (externalReferences.length) resultInvalid(externalReferences.map(issue => ({
    field: issue.path,
    message: 'Usuń odwołanie do zewnętrznego serwisu. Zapisz samodzielną treść kulinarną bez nazw źródeł, linków, domen i cytowań, zachowując technikę oraz warunki bezpiecznego przygotowania i przechowywania.',
  })));
  if (presentation && !isValidHeroPresentation(content.recipe, presentation)) resultInvalid([{ field: 'heroPresentation', message: 'Opis gotowej potrawy musi wskazywać istniejące, unikalne kroki i zawierać oba języki.' }]);
  // IDs, source text, author and bibliography are controlled by the application.
  // AI never creates claims of kitchen testing or fabricates citation URLs.
  const parsed = editorialContentSchema.safeParse(content);
  if (!parsed.success) resultInvalid(parsed.error.issues.map(issue => ({ field: issue.path.join('.') || 'recipe', message: issue.message })));
  const validated = structuredClone(content);
  for (const item of validated.recipe.substitutions ?? []) item.status = 'approved';
  const issues = publicationIssues(validated, undefined, undefined, verifiedAliases).filter(issue => !/(^image$|^imageAlt\.|^heroPresentation(?:\.|$)|\.photo(?:\.|$))/.test(issue.field));
  if (issues.length) resultInvalid(issues);
  const retained = new Set(proposal.ingredients.map(ingredient => ingredient.id));
  const steps = new Set(proposal.steps.map(step => step.id));
  content.photos.ingredients = Object.fromEntries(Object.entries(content.photos.ingredients).filter(([id]) => retained.has(id)));
  content.photos.steps = Object.fromEntries(Object.entries(content.photos.steps).filter(([id]) => steps.has(id)));
  return { content, notes: ['Przed publikacją sprawdź proporcje, kompletność i podział etapów, warunki przejścia dalej, początki minutników, oba języki i zgodność fotografii.',
    ...(planned ? timingPlan!.assumptions : []), ...notes].slice(0, 40) };
}
